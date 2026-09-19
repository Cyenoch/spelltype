import { HTTPException } from 'hono/http-exception';
import type { AuthRateLimit, ServerConfig } from '../config';

/**
 * 当前部署的身份验证速率配额。`readServerConfig` 从
 * `AUTH_RATE_LIMIT_ATTEMPTS` / `AUTH_RATE_LIMIT_WINDOW_MS`（默认为每 60 秒 10 次）中派生该配置；
 * 端到端（e2e）测试套件会调高该值，避免自动化测试流程误触限流。
 */
export function authRateLimits(config: ServerConfig): AuthRateLimit {
  return config.authLimits;
}

/** 单个限流器在触发驱逐前最多可追踪的不同客户端数量；存储空间是有界的，而非无限制增长。 */
const MAX_TRACKED_CLIENTS = 10_000;

interface WindowHit {
  count: number;
  resetAt: number;
}

/**
 * 原生身份验证限流器，用于替代平台的限流绑定机制：针对 `scope:client` 维度的键采用固定窗口计数器，
 * 并对存储容量施加严格上限。
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
            // 依然处于满载状态：淘汰最早过期的窗口，防止长时间的恶意刷量攻击将正常客户端挤出追踪列表。
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

/** 仅信任显式配置的请求头；入口网关层必须负责防止客户端伪造请求头。 */
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
