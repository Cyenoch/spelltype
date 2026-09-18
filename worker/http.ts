import { MAX_API_BODY_BYTES } from '../shared/protocol';
import type { Env } from './env';

/** An error that maps directly to a JSON API response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });
}

export function errorResponse(status: number, message: string, headers?: Record<string, string>): Response {
  return json({ error: message }, status, headers);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a JSON object body. The stream is capped at `limit` bytes and cancelled as soon as it goes
 * over, so an oversized or endless chunked body never gets buffered.
 */
export async function readJsonBody(request: Request, limit = MAX_API_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) throw new HttpError(413, '请求内容过大');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '请求内容不能为空');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(413, '请求内容过大');
    }
    chunks.push(value);
  }
  if (total === 0) throw new HttpError(400, '请求内容不能为空');
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new HttpError(400, '请求内容不是合法 JSON');
  }
  if (!isPlainObject(parsed)) throw new HttpError(400, '请求内容不是合法 JSON');
  return parsed;
}

/**
 * Same-origin enforcement for every state change and WebSocket handshake.
 * The origin must be a real origin value (scheme, host and port) equal to the request's own origin;
 * `Origin: null`, opaque origins and foreign hosts are all rejected.
 */
export function assertSameOrigin(request: Request, url: URL): void {
  const origin = request.headers.get('origin');
  if (!origin) throw new HttpError(403, '缺少来源信息，请求已被拒绝');
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new HttpError(403, '请求来源不受信任');
  }
  if (
    !parsed.origin ||
    parsed.origin === 'null' ||
    parsed.origin !== url.origin ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new HttpError(403, '请求来源不受信任');
  }
}

/**
 * Counts every authentication attempt, before any password hashing, so an unauthenticated caller
 * cannot spend the isolate's CPU on KDF work. `env.AUTH_LIMITER` is the platform rate-limit binding.
 */
export async function enforceAuthRateLimit(env: Env, request: Request, scope: 'register' | 'login'): Promise<void> {
  const ip = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for') ?? 'local';
  try {
    const { success } = await env.AUTH_LIMITER.limit({ key: `${scope}:${ip}` });
    if (!success) throw new HttpError(429, '尝试次数过多，请稍后再试');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // A limiter outage must not lock players out of their own accounts.
    console.error(`auth limiter unavailable: ${errorText(err)}`);
  }
}

/** `Secure` is only set on HTTPS, so local HTTP development keeps working. */
export function isSecureRequest(url: URL): boolean {
  return url.protocol === 'https:';
}

/** Errors are logged as text only: never request bodies, credentials or provider payloads. */
export function errorText(err: unknown, maxLength = 200): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > maxLength ? `${message.slice(0, maxLength)}…` : message;
}
