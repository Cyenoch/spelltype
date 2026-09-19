/**
 * 微信测试套件：中继令牌契约加上确定性的桥接夹具。
 *
 * 仅供测试使用的基础设施：绝不被产品代码导入。真实部署信任一个持有微信凭据的外部桥接服务，
 * 它用一个签名中继令牌来回应服务端的重定向；`startWechatBridge()` 就是那个对端在本地
 * HTTP 上的夹具，而 `relayClaims`/`signRelayToken`/`signForgedToken` 构造并签名出
 * `server/auth/wechat.ts` 所校验的确切令牌形态 ——
 * 因此测试套件走的是真实的校验路径，只是把远端凭据持有者模拟了出来。
 *
 * 身份以昵称为键：同一个昵称总是映射到同一个微信身份
 * （确定性地推导出 `union:`），因此「以同一名玩家再次登录」的表现与真实用户一致，
 * 而不同的昵称就是不同的账号。
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 桥接夹具的坐标，与服务端 `wechatBridge` 配置所期望的形式一致。 */
export const TEST_WECHAT_BRIDGE = {
  baseUrl: 'https://bridge.example',
  appId: 'spelltype-test-app',
  appKey: 'spelltype-e2e-wechat-app-key',
} as const;
/** 单独的 app key：多个单元测试会直接针对它签名令牌。 */
export const TEST_WECHAT_APP_KEY: string = TEST_WECHAT_BRIDGE.appKey;
export const TEST_WECHAT_IDENTITY_COOKIE = 'spelltype_fixture_nickname';
/**
 * 产品授予管理员角色的唯一微信身份：服务端所校验的那个确切的已核实 UnionID。
 * 其他任何身份都是普通的 `user`。
 */
export const ADMIN_NICKNAME = '管理员';
export const ADMIN_UNIONID = 'omBLS6xCiew0470A53hBYx0mzCbw';

/** 真实桥接编码进一个中继令牌的确切载荷。 */
export interface RelayClaims {
  v: 1;
  iss: string;
  aud: string;
  /** 该登录所属的桥接应用；服务端会拒绝其他任何应用的令牌。 */
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

/** 针对夹具桥接的一次全新登录的诚实声明，可按场景覆盖。 */
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
 * 完全按真实桥接的方式对声明签名：base64url 的 JSON、一个点，
 * 以及服务端会逐位校验的 43 字符 base64url HMAC-SHA256。
 */
export function signRelayToken(claims: RelayClaims, appKey = TEST_WECHAT_APP_KEY): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', appKey).update(body).digest('base64url');
  return `${body}.${signature}`;
}

/** 默认使用外来的 app key 签名：这是服务端必须拒绝的伪造令牌形态。 */
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
  /** 稳定 `openid` 的基础值；除非被覆盖，union id 由它推导而来。 */
  openid: string;
  /** 回调上报的资料昵称；服务端将其转为账号名。 */
  nickname: string;
  /** 覆盖推导出的 union id —— 管理员身份会固定为产品所授予的那个。 */
  unionid?: string;
  /** 设置后，回调携带 `wx_bridge_error` 而非令牌（用于失败场景）。 */
  failWith?: WechatBridgeFailure;
}

/** 一个全新的 43 字符 base64url 值 —— 中继 `jti` 所使用的确切形态。 */
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

/** 当测试未注册任何身份时，昵称所对应的身份：按昵称确定性生成。 */
function fallbackIdentity(nickname: string): WechatIdentity {
  return { openid: `open-${nickname || randomUUID()}`, nickname: nickname || '微信玩家' };
}

export interface WechatBridge {
  /** 服务端 `wechatBridge.baseUrl` 所指向的基础 URL。 */
  origin: string;
  /** 注册（或替换）某个昵称登录时所用的身份。 */
  register(identity: WechatIdentity): void;
  /** 在某个夹具回复到达浏览器之前修改它，而不拦截重定向。 */
  rewriteNextRelay(rewrite: (destination: URL) => void): void;
  /** 清空所有已注册身份：此后的登录回退到新的确定性身份。 */
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

        // 仅夹具使用的 Cookie 在不改写产品 URL 的前提下选择浏览器身份。
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
            // 即便拒绝握手，桥接也会回显该 state。
            destination.searchParams.set('state', state);
            destination.searchParams.set('wx_bridge_error', identity.failWith);
            sendRelay(response, destination);
            return;
          }
          const now = Math.floor(Date.now() / 1000);
          const claims: RelayClaims = {
            v: 1,
            // 服务端会用其配置的桥接基础 URL 校验 `iss`：也就是本夹具。
            iss: origin,
            aud: destination.origin,
            // 服务端会拒绝任何为其他 app id 签发的令牌。
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

        // 控制面：测试用例（经由各辅助函数）可固定身份或将其重置。
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
