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

/** Explicitly configured headers are trusted; the ingress must prevent client spoofing. */
export function rateLimitKey(
  peerAddress: string | undefined,
  headerValue: string | undefined,
  headerName: ServerConfig['trustForwardedFor'],
): string {
  if (headerName && headerValue) {
    const observed =
      headerName === 'x-forwarded-for'
        ? headerValue.slice(headerValue.lastIndexOf(',') + 1).trim()
        : headerValue.trim();
    if (observed) return observed;
  }
  return peerAddress ?? 'local';
}
