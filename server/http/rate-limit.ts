import { HTTPException } from 'hono/http-exception';
import type { AuthRateLimit, ServerConfig } from '../config';

/**
 * The deployment's authentication budget. `readServerConfig` derives it from
 * `AUTH_RATE_LIMIT_ATTEMPTS` / `AUTH_RATE_LIMIT_WINDOW_MS` (default 10 per 60 seconds); the e2e
 * harness raises it so test flows never trip the limiter.
 */
export function authRateLimits(config: ServerConfig): AuthRateLimit {
  return config.authLimits;
}

/** How many distinct clients one limiter tracks before eviction; storage is bounded, not unbounded. */
const MAX_TRACKED_CLIENTS = 10_000;

interface WindowHit {
  count: number;
  resetAt: number;
}

/**
 * The native authentication limiter, replacing the platform rate-limit binding: a fixed-window
 * counter per `scope:client` key with hard-bounded storage.
 */
export interface AuthRateLimiter {
  limit(scope: string, client: string): void;
}

export function createAuthRateLimiter(limits: AuthRateLimit): AuthRateLimiter {
  const hits = new Map<string, WindowHit>();

  function prune(now: number): void {
    for (const [key, hit] of hits) {
      if (hit.resetAt <= now) hits.delete(key);
    }
  }

  return {
    limit(scope, client) {
      const now = Date.now();
      const key = `${scope}:${client}`;
      let hit = hits.get(key);
      if (!hit || hit.resetAt <= now) {
        if (hits.size >= MAX_TRACKED_CLIENTS) {
          prune(now);
          if (hits.size >= MAX_TRACKED_CLIENTS) {
            // Still full: drop the window that expires soonest so a long abuse campaign cannot
            // evict honest clients from tracking.
            let oldestKey = key;
            let oldestResetAt = Number.MAX_SAFE_INTEGER;
            for (const [candidate, value] of hits) {
              if (value.resetAt < oldestResetAt) {
                oldestKey = candidate;
                oldestResetAt = value.resetAt;
              }
            }
            hits.delete(oldestKey);
          }
        }
        hit = { count: 0, resetAt: now + limits.windowMs };
        hits.set(key, hit);
      }
      hit.count += 1;
      if (hit.count > limits.attempts) {
        throw new HTTPException(429, { message: '尝试次数过多，请稍后再试' });
      }
    },
  };
}

/**
 * The client identity for one authentication attempt.
 *
 * The key is the socket's own peer address — reported by the runtime, not by any header — so a
 * direct client cannot rotate its identity. The forwarded chain is honored only when the
 * deployment explicitly trusts its edge (`trustForwardedFor`) AND that peer is an internal
 * address: the pinned edge is the only host that can reach the API port, and it appends the real
 * client address, so the rightmost entry is what it observed. Loopback alone is not trusted — a
 * direct local request can set any header it likes. External peers, untrusted deployments, and
 * dispatches with no socket all collapse onto their own fixed keys; client-spoofable values never
 * decide.
 */
export function rateLimitKey(
  peerAddress: string | undefined,
  forwardedFor: string | undefined,
  trustForwardedFor: boolean,
): string {
  if (
    trustForwardedFor &&
    peerAddress !== undefined &&
    isInternalPeer(peerAddress) &&
    forwardedFor
  ) {
    const entries = forwardedFor.split(',');
    const observed = entries[entries.length - 1].trim();
    if (observed.length > 0) return observed;
  }
  return peerAddress ?? 'local';
}

/** Loopback, RFC 1918 and IPv6 unique/link-local ranges: where our own proxies live. */
export function isInternalPeer(address: string): boolean {
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return (
    normalized === '127.0.0.1' ||
    normalized.startsWith('127.') ||
    normalized.startsWith('10.') ||
    normalized.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    normalized === '::1' ||
    /^f[cd][0-9a-f]{2}:/.test(normalized) ||
    normalized.startsWith('fe80:')
  );
}
