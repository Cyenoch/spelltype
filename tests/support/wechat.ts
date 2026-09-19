/**
 * The WeChat test kit: the relay-token contract plus the deterministic bridge fixture.
 *
 * Test-only infrastructure: never imported by product code. The real deployment trusts an external
 * bridge service that owns WeChat credentials and answers the server's redirect with a signed relay
 * token; `startWechatBridge()` is that peer as a local HTTP fixture, and `relayClaims`/
 * `signRelayToken`/`signForgedToken` build and sign the exact token shapes
 * `server/auth/wechat.ts` verifies — so the suite exercises the real verification path, with only
 * the remote credential holder simulated.
 *
 * Identities are keyed by nickname: the same nickname always maps to the same WeChat identity
 * (`union:` derived deterministically), so "sign in again as the same player" works like it does
 * for a real user, while distinct nicknames are distinct accounts.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The bridge fixture's coordinates, as the server's `wechatBridge` config expects them. */
export const TEST_WECHAT_BRIDGE = {
  baseUrl: 'https://bridge.example',
  appId: 'spelltype-test-app',
  appKey: 'spelltype-e2e-wechat-app-key',
} as const;
/** The app key, on its own: several unit specs sign tokens directly against it. */
export const TEST_WECHAT_APP_KEY: string = TEST_WECHAT_BRIDGE.appKey;
export const TEST_WECHAT_IDENTITY_COOKIE = 'spelltype_fixture_nickname';
/**
 * The one WeChat identity the product grants the admin role: the exact verified UnionID the
 * server checks. Every other identity is an ordinary `user`.
 */
export const ADMIN_NICKNAME = '管理员';
export const ADMIN_UNIONID = 'omBLS6xCiew0470A53hBYx0mzCbw';

/** The payload the real bridge encodes into one relay token, verbatim. */
export interface RelayClaims {
  v: 1;
  iss: string;
  aud: string;
  /** The bridge app the login belongs to; the server refuses any other app's tokens. */
  app_id: string;
  provider: 'wechat';
  channel: 'open' | 'mp';
  iat: number;
  exp: number;
  jti: string;
  openid: string;
  unionid?: string;
  nickname?: string;
}

/** Honest claims for one fresh login against the fixture bridge, overridable per scenario. */
export function relayClaims(patch: Partial<RelayClaims> = {}): RelayClaims {
  const now = Math.floor(Date.now() / 1000);
  const jti = patch.jti ?? randomBytes(32).toString('base64url');
  return {
    v: 1,
    iss: TEST_WECHAT_BRIDGE.baseUrl,
    aud: 'https://app.example',
    app_id: TEST_WECHAT_BRIDGE.appId,
    provider: 'wechat',
    channel: 'open',
    iat: now,
    exp: now + 300,
    jti,
    openid: `open-${jti}`,
    unionid: `union-${jti}`,
    nickname: '咒文使',
    ...patch,
  };
}

/**
 * Signs claims exactly the way the real bridge does: base64url JSON, a dot, and the 43-character
 * base64url HMAC-SHA256 the server verifies bit for bit.
 */
export function signRelayToken(claims: RelayClaims, appKey = TEST_WECHAT_APP_KEY): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', appKey).update(body).digest('base64url');
  return `${body}.${signature}`;
}

/** Signs with a foreign app key by default: the forged-token shape the server must refuse. */
export function signForgedToken(
  claims: RelayClaims | Record<string, unknown>,
  appKey = 'a-foreign-bridge-app-key-that-is-long-enough',
): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', appKey).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export type WechatBridgeFailure = 'user_denied' | 'timeout';

export interface WechatIdentity {
  /** Base for the stable `openid`; the union id is derived from it unless overridden. */
  openid: string;
  /** The profile nickname the callback reports; the server turns it into the account name. */
  nickname: string;
  /** Overrides the derived union id — an admin identity pins the product's granted one. */
  unionid?: string;
  /** When set, the callback carries `wx_bridge_error` instead of a token (failure scenarios). */
  failWith?: WechatBridgeFailure;
}

/** A fresh 43-character base64url value — the exact shape the relay `jti` uses. */
function freshJti(): string {
  return randomBytes(32).toString('base64url');
}

function writeRedirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location });
  response.end();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/** The identity a nickname gets when the spec registered none: deterministic per nickname. */
function fallbackIdentity(nickname: string): WechatIdentity {
  return { openid: `open-${nickname || randomUUID()}`, nickname: nickname || '微信玩家' };
}

export interface WechatBridge {
  /** The base URL the server's `wechatBridge.baseUrl` points at. */
  origin: string;
  /** Registers (or replaces) the identity a nickname signs in with. */
  register(identity: WechatIdentity): void;
  /** Alters one fixture reply before it reaches the browser, without intercepting redirects. */
  rewriteNextRelay(rewrite: (destination: URL) => void): void;
  /** Drops every registered identity: later logins fall back to fresh deterministic ones. */
  reset(): void;
  close(): Promise<void>;
}

export async function startWechatBridge(): Promise<WechatBridge> {
  const identities = new Map<string, WechatIdentity>();
  let nextRewrite: ((destination: URL) => void) | null = null;

  function sendRelay(response: ServerResponse, destination: URL): void {
    const rewrite = nextRewrite;
    nextRewrite = null;
    rewrite?.(destination);
    writeRedirect(response, destination.href);
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? '/', 'http://fixture.wechat');

        // The fixture-only cookie selects the browser's identity without rewriting product URLs.
        if (url.pathname === '/api/auth/wechat/bridge/start') {
          if (url.searchParams.get('app_id') !== TEST_WECHAT_BRIDGE.appId) {
            writeJson(response, 400, { error: 'unknown app_id' });
            return;
          }
          const state = url.searchParams.get('state');
          if (!state) {
            writeJson(response, 400, { error: 'missing top-level state' });
            return;
          }
          const returnUrl = url.searchParams.get('return_url');
          if (!returnUrl) {
            writeJson(response, 400, { error: 'missing return_url' });
            return;
          }
          const destination = new URL(returnUrl);
          if (destination.search) {
            writeJson(response, 400, { error: 'return_url must arrive without a query' });
            return;
          }
          const identityCookie = request.headers.cookie
            ?.split(';')
            .map((entry) => entry.trim())
            .find((entry) => entry.startsWith(`${TEST_WECHAT_IDENTITY_COOKIE}=`));
          const nickname = identityCookie
            ? decodeURIComponent(identityCookie.slice(TEST_WECHAT_IDENTITY_COOKIE.length + 1))
            : '';
          const identity = identities.get(nickname) ?? fallbackIdentity(nickname);
          if (identity.failWith) {
            // The bridge echoes the state even when it refuses the handshake.
            destination.searchParams.set('state', state);
            destination.searchParams.set('wx_bridge_error', identity.failWith);
            sendRelay(response, destination);
            return;
          }
          const now = Math.floor(Date.now() / 1000);
          const claims: RelayClaims = {
            v: 1,
            // The server verifies `iss` against its configured bridge base URL: this fixture.
            iss: origin,
            aud: destination.origin,
            // The server refuses any token minted for another app id.
            app_id: TEST_WECHAT_BRIDGE.appId,
            provider: 'wechat',
            channel: 'open',
            iat: now,
            exp: now + 300,
            jti: freshJti(),
            openid: identity.openid,
            unionid: identity.unionid ?? `union-${identity.openid}`,
            nickname: identity.nickname,
          };
          const token = signRelayToken(claims);
          destination.searchParams.set('state', state);
          destination.searchParams.set('token', token);
          sendRelay(response, destination);
          return;
        }

        // Control surface: the specs (through the helpers) pin identities or reset them.
        if (url.pathname === '/__control/identities' && request.method === 'POST') {
          const body = JSON.parse((await readBody(request)) || '{}') as {
            nickname?: string;
            identity?: Partial<Omit<WechatIdentity, 'nickname'>>;
            reset?: boolean;
          };
          if (body.reset) identities.clear();
          if (body.nickname) {
            identities.set(body.nickname, {
              openid: body.identity?.openid ?? `open-${body.nickname}`,
              nickname: body.nickname,
              failWith: body.identity?.failWith,
            });
          }
          writeJson(response, 200, { ok: true });
          return;
        }

        writeJson(response, 404, {
          error: `fixture bridge: unknown route ${request.method} ${url.pathname}`,
        });
      } catch (error) {
        writeJson(response, 500, { error: (error as Error).message });
      }
    })();
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    register: (identity) => {
      identities.set(identity.nickname, identity);
    },
    rewriteNextRelay: (rewrite) => {
      if (nextRewrite) throw new Error('A relay rewrite is already pending.');
      nextRewrite = rewrite;
    },
    reset: () => {
      identities.clear();
      nextRewrite = null;
    },
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}
