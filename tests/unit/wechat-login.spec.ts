/**
 * 微信登录边界 —— 会话生死所系的中继桥接契约。
 *
 * 每个用例都通过真实稳定应用（`server/http/app.ts`）在真实 PGlite 数据库上，
 * 配合共享测试桥接（`tests/support/wechat.ts`）驱动：
 * 向外的重定向、签名中继回调、一次性 state 与令牌账本，以及由此产生的会话 Cookie。
 * 此处出错意味着账号被接管（伪造的中继被当作身份接受），
 * 或是登录在下一个请求上即告失败，因此这里没有任何隔了一层的固定物：
 * 被测的响应就是浏览器与桥接实际交换的那些。
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { hashToken, SESSION_COOKIE, sessionHashFromToken } from '../../server/auth/sessions';
import {
  WECHAT_STATE_COOKIE,
  WECHAT_STATE_PATTERN,
  WECHAT_STATE_TTL_SECONDS,
} from '../../server/auth/wechat';
import type { ServerConfig } from '../../server/config';
import type { RoomRuntimePort } from '../../server/contracts';
import { openDatabase, type OpenedDatabase } from '../../server/db';
import { accounts, sessions, wechatLoginAttempts, wechatRelayTokens } from '../../server/db/schema';
import { createApp } from '../../server/http/app';
import type { HttpEnv } from '../../server/http/context';
import { createRoomRuntime } from '../../server/rooms';
import {
  relayClaims,
  signForgedToken,
  signRelayToken,
  TEST_WECHAT_BRIDGE,
  ADMIN_UNIONID,
  type RelayClaims,
} from '../support/wechat';

const ORIGIN = 'https://app.example';
const INSECURE_ORIGIN = 'http://app.example';
const ROOM_ID = '0123456789abcdef01234567';

let database: OpenedDatabase;
let runtime: RoomRuntimePort;
afterAll(async () => {
  await runtime?.close();
  await database?.close();
});

describe('微信登录边界', () => {
  afterEach(async () => {
    // 每个用例从干净表开始；连接保留到整个文件结束。纯未配置桥接的用例不写库。
    if (database) {
      await database.db.delete(wechatRelayTokens);
      await database.db.delete(wechatLoginAttempts);
      await database.db.delete(sessions);
      await database.db.delete(accounts);
    }
  });

  /** 响应为某个 Cookie 所设置的完整 Set-Cookie 请求头，可能分布在多个头中。 */
  function setCookieHeaderOf(response: Response, name: string): string {
    const header = response.headers.getSetCookie().find((entry) => entry.startsWith(`${name}=`));
    if (header === undefined) throw new Error(`response set no cookie named ${name}`);
    return header;
  }

  /** 绝对重定向目标，按浏览器的方式相对公开源解析得到。 */
  function locationOf(response: Response, origin: string): URL {
    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location, 'redirect responses must carry a location').not.toBeNull();
    return new URL(location!, origin);
  }

  /** 回调在任何失败情况下都必须退化到的重定向目标。 */
  function expectFailureRedirect(response: Response, origin: string, room?: string): URL {
    const landed = locationOf(response, origin);
    expect(landed.pathname).toBe('/auth');
    expect(landed.searchParams.get('error')).toBe('wechat_failed');
    if (room === undefined) expect(landed.searchParams.has('room')).toBe(false);
    else expect(landed.searchParams.get('room')).toBe(room);
    return landed;
  }

  async function startLogin(app: HonoLike, origin: string, room?: string): Promise<Response> {
    const query = room === undefined ? '' : `?room=${room}`;
    return app.request(`/api/auth/wechat/start${query}`, { headers: { origin } });
  }

  interface CallbackOptions {
    state?: string | null;
    token?: string | null;
    stateCookie?: string | null;
    bridgeError?: boolean;
  }

  /** 与桥接重定向所送达（或攻击者所伪造）完全一致的回调。 */
  async function callback(app: HonoLike, options: CallbackOptions = {}): Promise<Response> {
    const query = new URLSearchParams();
    if (options.state !== null) query.set('state', options.state ?? '');
    if (options.token !== null) query.set('token', options.token ?? '');
    if (options.bridgeError) query.set('wx_bridge_error', '1');
    const headers: Record<string, string> = {};
    if (options.stateCookie !== null) {
      headers.cookie = `${WECHAT_STATE_COOKIE}=${options.stateCookie ?? ''}`;
    }
    return app.request(`/api/auth/wechat/callback?${query}`, { headers });
  }

  interface RoundTripOptions {
    room?: string;
    claims?: Partial<RelayClaims>;
    /** 使用外来的 app key 签名，而不是夹具自身的。 */
    appKey?: string;
    token?: string;
  }

  /** 驱动开始流程加上一次签名回调 —— 与浏览器在 E2E 中所走的同一次往返。 */
  async function roundTrip(
    app: HonoLike,
    origin: string,
    options: RoundTripOptions = {},
  ): Promise<{ state: string; token: string; claims: RelayClaims; response: Response }> {
    const start = await startLogin(app, origin, options.room);
    const state = setCookieHeaderOf(start, WECHAT_STATE_COOKIE).split(';')[0].split('=')[1];
    const claims = relayClaims({ aud: origin, unionid: undefined, ...options.claims });
    const token = options.token ?? signRelayToken(claims, options.appKey);
    const response = await callback(app, { state, token, stateCookie: state });
    return { state, token, claims, response };
  }

  it('未配置桥接时把浏览器送回 /auth 并声明不可用，邀请原样保留且毫无痕迹', async () => {
    const app = await testApp(INSECURE_ORIGIN, null);
    for (const room of [ROOM_ID, undefined]) {
      const response = await startLogin(app, INSECURE_ORIGIN, room);
      const landed = locationOf(response, INSECURE_ORIGIN);
      expect(landed.pathname).toBe('/auth');
      expect(landed.searchParams.get('error')).toBe('wechat_unavailable');
      if (room === undefined) expect(landed.searchParams.has('room')).toBe(false);
      else expect(landed.searchParams.get('room')).toBe(room);
      // 未配置就绝不能发出登录状态，也不能留下任何可兑换的发起记录。
      expect(response.headers.getSetCookie()).toEqual([]);
      if (database) expect(await database.db.select().from(wechatLoginAttempts)).toEqual([]);
    }
  });

  it('房间号形状不对时在落库之前就被拒绝', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const response = await startLogin(app, INSECURE_ORIGIN, 'not-a-room');
    expect(response.status).toBe(400);
  });

  it('已配置应用时重定向到桥接发起地址，浏览器状态与回调绑定，库里只有哈希', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const response = await startLogin(app, INSECURE_ORIGIN, ROOM_ID);
    const bridgeUrl = locationOf(response, INSECURE_ORIGIN);
    expect(bridgeUrl.origin).toBe(TEST_WECHAT_BRIDGE.baseUrl);
    expect(bridgeUrl.pathname).toBe('/api/auth/wechat/bridge/start');
    // 发起请求自报应用身份，随机状态在顶层原样交给桥接，由桥接回跳时原样带回。
    expect(bridgeUrl.searchParams.get('app_id')).toBe(TEST_WECHAT_BRIDGE.appId);
    const state = bridgeUrl.searchParams.get('state')!;
    expect(state).toMatch(WECHAT_STATE_PATTERN);
    // 桥接回调地址不带任何查询：状态由桥接回填，绝不搭车藏在 return_url 里。
    const returnUrl = new URL(bridgeUrl.searchParams.get('return_url')!);
    expect(returnUrl.origin).toBe(INSECURE_ORIGIN);
    expect(returnUrl.pathname).toBe('/api/auth/wechat/callback');
    expect(returnUrl.search).toBe('');
    expect(bridgeUrl.searchParams.get('channel')).toBe('auto');
    expect(bridgeUrl.searchParams.get('mp_scope')).toBe('snsapi_userinfo');
    // 应用密钥只留在服务端验签，绝不能跟着登录跳转出现在浏览器可见的地址里。
    expect(bridgeUrl.href).not.toContain(TEST_WECHAT_BRIDGE.appKey);
    expect(returnUrl.href).not.toContain(TEST_WECHAT_BRIDGE.appKey);

    // Cookie 属性：HttpOnly + Lax（跨站跳转回来要靠它），HTTP 源下不带 Secure。
    const header = setCookieHeaderOf(response, WECHAT_STATE_COOKIE);
    expect(header).toContain(`${WECHAT_STATE_COOKIE}=${state}`);
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain(`Max-Age=${WECHAT_STATE_TTL_SECONDS}`);
    expect(header).not.toContain('Secure');

    // 发起记录按 SHA256(state) 主键落库，原文不落库，邀请与有效期一并保存。
    const [attempt] = await database.db.select().from(wechatLoginAttempts);
    expect(attempt.state_hash).toBe(hashToken(state));
    expect(attempt.room_id).toBe(ROOM_ID);
    expect(attempt.expires_at).toBeGreaterThan(Date.now());
    expect(attempt.expires_at).toBeLessThanOrEqual(Date.now() + WECHAT_STATE_TTL_SECONDS * 1000);
  });

  it('有效回调建立会话并一次性消费状态与令牌', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const { claims, response } = await roundTrip(app, INSECURE_ORIGIN, {
      claims: { channel: 'open', openid: 'o_wizard', nickname: '星界法师\u200b ' },
    });
    // 回到首页，没有邀请就不带 room。
    expect(
      locationOf(response, INSECURE_ORIGIN).pathname + locationOf(response, INSECURE_ORIGIN).search,
    ).toBe('/');

    const header = setCookieHeaderOf(response, SESSION_COOKIE);
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).not.toContain('Secure');

    // 下发的令牌必须正是会话读取端接受的形状，否则登录完刷新就掉线。
    const sessionToken = header.slice(`${SESSION_COOKIE}=`.length).split(';')[0];
    expect(sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionHashFromToken(sessionToken)).toBe(hashToken(sessionToken));

    const [account] = await database.db.select().from(accounts);
    expect(account.username).toBe('星界法师'); // 控制字符剥离、首尾裁剪
    expect(account.wechat_identity).toBe('open:o_wizard');

    const [session] = await database.db.select().from(sessions);
    expect(session.token_hash).toBe(hashToken(sessionToken));
    expect(session.user_id).toBe(account.id);

    // 状态与令牌都是一次性的：兑换之后各自的台账不剩任何可重放的东西。
    expect(await database.db.select().from(wechatLoginAttempts)).toEqual([]);
    const [relay] = await database.db.select().from(wechatRelayTokens);
    expect(relay.jti).toBe(claims.jti);
    expect(relay.expires_at).toBe(claims.exp * 1000);
  });

  it('HTTPS 公网源下发起与会话 Cookie 都带 Secure', async () => {
    const app = await testApp(ORIGIN);
    const start = await startLogin(app, ORIGIN);
    expect(setCookieHeaderOf(start, WECHAT_STATE_COOKIE)).toContain('Secure');
    const { response } = await roundTrip(app, ORIGIN);
    expect(setCookieHeaderOf(response, SESSION_COOKIE)).toContain('Secure');
  });

  it('unionid 优先于 openid；无 Open 平台身份的 mp 用户单独成账号', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const { response: unionResponse } = await roundTrip(app, INSECURE_ORIGIN, {
      claims: { channel: 'open', openid: 'o_a', unionid: 'u_x' },
    });
    expect(unionResponse.status).toBe(302);
    const { response: mpResponse } = await roundTrip(app, INSECURE_ORIGIN, {
      claims: { channel: 'mp', openid: 'mp_1' },
    });
    expect(mpResponse.status).toBe(302);

    const identities = (await database.db.select().from(accounts))
      .map((row) => row.wechat_identity)
      .sort();
    expect(identities).toEqual(['mp:mp_1', 'union:u_x']);
  });

  it('同一身份再次登录更新昵称而非新建账号；缺失昵称保留原显示名', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    await roundTrip(app, INSECURE_ORIGIN, { claims: { openid: 'o_same', nickname: '旧名' } });
    await roundTrip(app, INSECURE_ORIGIN, { claims: { openid: 'o_same', nickname: '新名' } });
    // 桥接没给昵称时，绝不能把显示名抹成占位符。
    await roundTrip(app, INSECURE_ORIGIN, { claims: { openid: 'o_same', nickname: undefined } });

    const rows = await database.db.select().from(accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe('新名');
    expect(rows[0].wechat_identity).toBe('open:o_same');
    // 每次登录都是一条新会话，不是复用旧的。
    expect(await database.db.select().from(sessions)).toHaveLength(3);
  });

  it('不同身份的同名昵称并存：显示名从不参与唯一性', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    await roundTrip(app, INSECURE_ORIGIN, { claims: { openid: 'o_one', nickname: '法师' } });
    await roundTrip(app, INSECURE_ORIGIN, { claims: { openid: 'o_two', nickname: '法师' } });
    const rows = await database.db.select().from(accounts).orderBy(accounts.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.username)).toEqual(['法师', '法师']);
  });

  it('会话回调把邀请一路带回房间', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const { response } = await roundTrip(app, INSECURE_ORIGIN, { room: ROOM_ID });
    const landed = locationOf(response, INSECURE_ORIGIN);
    expect(landed.pathname).toBe('/');
    expect(landed.searchParams.get('room')).toBe(ROOM_ID);
  });

  it('桥接失败响应也销毁状态，之后同一状态无法重放', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const start = await startLogin(app, INSECURE_ORIGIN, ROOM_ID);
    const state = setCookieHeaderOf(start, WECHAT_STATE_COOKIE).split(';')[0].split('=')[1];

    const failed = await callback(app, { state, stateCookie: state, bridgeError: true });
    expectFailureRedirect(failed, INSECURE_ORIGIN, ROOM_ID);
    expect(await database.db.select().from(wechatLoginAttempts)).toEqual([]);

    // 状态已销毁：拿同一状态再交一个完全有效的令牌也过不去。
    const replayed = await callback(app, {
      state,
      token: signRelayToken(relayClaims({ aud: INSECURE_ORIGIN })),
      stateCookie: state,
    });
    expectFailureRedirect(replayed, INSECURE_ORIGIN);
  });

  it('状态是回调的唯一 CSRF 凭证：缺失、不匹配、未知、畸形或过期都失败', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const start = await startLogin(app, INSECURE_ORIGIN);
    const state = setCookieHeaderOf(start, WECHAT_STATE_COOKIE).split(';')[0].split('=')[1];
    const token = signRelayToken(relayClaims({ aud: INSECURE_ORIGIN }));

    // 攻击者直接把受害者引到回调地址：没有发起时的 Cookie 就绝不能建立会话。
    expectFailureRedirect(await callback(app, { state, token }), INSECURE_ORIGIN);
    // Cookie 与 query 不一致（CSRF 夹带别人会话里的状态）同样失败。
    expectFailureRedirect(
      await callback(app, { state, token, stateCookie: 'A'.repeat(43) }),
      INSECURE_ORIGIN,
    );
    // 从未发出的状态、形状不对的状态都不行。
    expectFailureRedirect(
      await callback(app, { state: 'B'.repeat(43), token, stateCookie: 'B'.repeat(43) }),
      INSECURE_ORIGIN,
    );
    expectFailureRedirect(
      await callback(app, { state: 'short', token, stateCookie: state }),
      INSECURE_ORIGIN,
    );

    // 库里只存哈希，但过期判断照样命中的是这一行：把有效期拨到过去再试。
    const [attempt] = await database.db.select().from(wechatLoginAttempts);
    expect(attempt.state_hash).toBe(hashToken(state));
    await database.db.update(wechatLoginAttempts).set({ expires_at: Date.now() - 1 });
    expectFailureRedirect(
      await callback(app, { state, token, stateCookie: state }),
      INSECURE_ORIGIN,
    );
  });

  it('签名对不上的令牌一律被拒绝', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const claims = relayClaims({ aud: INSECURE_ORIGIN });
    const token = signRelayToken(claims);
    const tokens = [
      // 最后一位换成合法 base64url 字符：载荷一字不差，签名差一点。
      `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
      signForgedToken(claims),
      // 形状与编码都不对的东西也不该走到签名比较之前就崩溃。
      'not-a-token',
      `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.tooshort`,
      `${Buffer.from('纯文本载荷', 'utf8').toString('base64url')}.${token.split('.')[1]}`,
    ];
    for (const forged of tokens) {
      const start = await startLogin(app, INSECURE_ORIGIN);
      const state = setCookieHeaderOf(start, WECHAT_STATE_COOKIE).split(';')[0].split('=')[1];
      expectFailureRedirect(
        await callback(app, { state, token: forged, stateCookie: state }),
        INSECURE_ORIGIN,
      );
    }
    expect(await database.db.select().from(accounts)).toEqual([]);
  });

  it('载荷声明越界的令牌即使签名正确也被拒绝', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const base = relayClaims({ aud: INSECURE_ORIGIN });
    const now = Math.floor(Date.now() / 1000);
    const payloads: Record<string, unknown>[] = [
      { ...base, iss: 'https://evil.test' },
      { ...base, aud: 'https://evil.example' },
      // 别家应用id签发的令牌、以及缺失应用id的令牌，即使密钥正确也过不去。
      { ...base, app_id: 'another-teams-app' },
      { ...base, app_id: undefined },
      { ...base, v: 2 },
      { ...base, provider: 'qq' },
      { ...base, channel: 'web' },
      { ...base, openid: undefined },
      { ...base, exp: now - 10 },
      { ...base, iat: now + 60 },
      { ...base, exp: base.iat },
    ];
    for (const payload of payloads) {
      const start = await startLogin(app, INSECURE_ORIGIN);
      const state = setCookieHeaderOf(start, WECHAT_STATE_COOKIE).split(';')[0].split('=')[1];
      expectFailureRedirect(
        await callback(app, {
          state,
          token: signForgedToken(payload, TEST_WECHAT_BRIDGE.appKey),
          stateCookie: state,
        }),
        INSECURE_ORIGIN,
      );
    }
    // 没有哪次伪造落过账号，也没有哪枚 jti 进过台账。
    expect(await database.db.select().from(accounts)).toEqual([]);
    expect(await database.db.select().from(wechatRelayTokens)).toEqual([]);
  });

  it('已兑换的 jti 不能再次换取会话：重放终止在错误提示', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const token = signRelayToken(relayClaims({ aud: INSECURE_ORIGIN, jti: 'replayed-jti' }));

    const first = await roundTrip(app, INSECURE_ORIGIN, { token });
    expect(first.response.status).toBe(302);

    const second = await roundTrip(app, INSECURE_ORIGIN, { token });
    expectFailureRedirect(second.response, INSECURE_ORIGIN);
    expect(await database.db.select().from(sessions)).toHaveLength(1);
  });

  it('登出清空会话 Cookie，且带相同的作用域属性', async () => {
    const app = await testApp(ORIGIN);
    const { token, response } = await roundTrip(app, ORIGIN);
    const sessionToken = setCookieHeaderOf(response, SESSION_COOKIE)
      .slice(`${SESSION_COOKIE}=`.length)
      .split(';')[0];

    const logout = await app.request('/api/logout', {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${sessionToken}` },
    });
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ ok: true });
    const header = setCookieHeaderOf(logout, SESSION_COOKIE);
    expect(header).toContain(`${SESSION_COOKIE}=;`);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('Path=/');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Secure');

    // 会话真的被吊销：令牌在库里不复存在。
    expect(await database.db.select().from(sessions)).toEqual([]);
    expect(token).not.toBe(sessionToken);
    const repeated = await app.request('/api/logout', {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${sessionToken}` },
    });
    expect(repeated.status).toBe(200);
    const signedOut = await app.request('/api/session', {
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
    });
    expect(await signedOut.json()).toEqual({ user: null, role: null });
  });

  it('/api/session 反映会话：匿名返回 null，登录后返回账号', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const anonymous = await app.request('/api/session');
    expect(await anonymous.json()).toEqual({ user: null, role: null });

    const { response } = await roundTrip(app, INSECURE_ORIGIN);
    const sessionToken = setCookieHeaderOf(response, SESSION_COOKIE)
      .slice(`${SESSION_COOKIE}=`.length)
      .split(';')[0];
    const session = await app.request('/api/session', {
      headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` },
    });
    expect(await session.json()).toEqual({
      user: { id: expect.any(String), username: '咒文使' },
      role: 'user',
    });
  });
  it('昵称按 Unicode 码点限制长度，缺失时使用默认显示名', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const long = await roundTrip(app, INSECURE_ORIGIN, { claims: { nickname: '𠮷'.repeat(70) } });
    const cookie = setCookieHeaderOf(long.response, SESSION_COOKIE).split(';')[0];
    const session = await app.request('/api/session', { headers: { cookie } });
    expect(await session.json()).toMatchObject({ user: { username: '𠮷'.repeat(64) } });
    const missing = await roundTrip(app, INSECURE_ORIGIN, { claims: { nickname: undefined } });
    const secondCookie = setCookieHeaderOf(missing.response, SESSION_COOKIE).split(';')[0];
    const second = await app.request('/api/session', { headers: { cookie: secondCookie } });
    expect(await second.json()).toMatchObject({ user: { username: '微信玩家' } });
  });

  it('不合法的会话令牌不能成为数据库查询凭据', () => {
    for (const token of [undefined, '', 'short', `${'A'.repeat(42)}+`]) {
      expect(sessionHashFromToken(token)).toBeNull();
    }
    expect(sessionHashFromToken('A'.repeat(43))).toBe(hashToken('A'.repeat(43)));
  });

  it('已验证的指定 UnionID 获得管理员权限，角色撤销立即生效且再次登录不恢复', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const first = await roundTrip(app, INSECURE_ORIGIN, { claims: { unionid: ADMIN_UNIONID } });
    const cookie = setCookieHeaderOf(first.response, SESSION_COOKIE).split(';')[0];
    const before = await app.request('/api/session', { headers: { cookie } });
    expect(await before.json()).toMatchObject({ role: 'admin' });
    expect((await app.request('/api/admin/maintenance', { headers: { cookie } })).status).toBe(200);

    await database.db
      .update(accounts)
      .set({ role: 'user' })
      .where(eq(accounts.wechat_identity, `union:${ADMIN_UNIONID}`));
    expect((await app.request('/api/admin/maintenance', { headers: { cookie } })).status).toBe(403);
    const again = await roundTrip(app, INSECURE_ORIGIN, { claims: { unionid: ADMIN_UNIONID } });
    const freshCookie = setCookieHeaderOf(again.response, SESSION_COOKIE).split(';')[0];
    const after = await app.request('/api/session', { headers: { cookie: freshCookie } });
    expect(await after.json()).toMatchObject({ role: 'user' });
    expect(
      (await app.request('/api/admin/maintenance', { headers: { cookie: freshCookie } })).status,
    ).toBe(403);
  });

  it('同名昵称或与管理员 UnionID 相同的 OpenID 都不能获取管理员权限', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const login = await roundTrip(app, INSECURE_ORIGIN, {
      claims: { openid: ADMIN_UNIONID, nickname: '管理员', unionid: undefined },
    });
    const cookie = setCookieHeaderOf(login.response, SESSION_COOKIE).split(';')[0];
    const session = await app.request('/api/session', { headers: { cookie } });
    expect(await session.json()).toMatchObject({ role: 'user' });
    expect(
      (await app.request('/api/admin/maintenance', { headers: { cookie, 'X-Role': 'admin' } }))
        .status,
    ).toBe(403);
  });

  it('伪造指定 UnionID 的签名不能创建账号或会话', async () => {
    const app = await testApp(INSECURE_ORIGIN);
    const login = await roundTrip(app, INSECURE_ORIGIN, {
      claims: { unionid: ADMIN_UNIONID },
      appKey: 'untrusted-bridge-app-key',
    });
    expectFailureRedirect(login.response, INSECURE_ORIGIN);
    expect(
      login.response.headers.getSetCookie().some((entry) => entry.startsWith(`${SESSION_COOKIE}=`)),
    ).toBe(false);
    expect(await database.db.select().from(accounts)).toEqual([]);
    expect(await database.db.select().from(sessions)).toEqual([]);
  });
});

type HonoLike = Pick<Hono<HttpEnv>, 'request'>;

async function testApp(
  publicOrigin: string,
  bridge: ServerConfig['wechatBridge'] = TEST_WECHAT_BRIDGE,
): Promise<HonoLike> {
  const config: ServerConfig = {
    buildId: 'wechat-test',
    databaseUrl: 'pglite://:memory:',
    hostname: '127.0.0.1',
    port: 0,
    publicOrigin,
    maintenanceToken: null,
    assetsRoot: null,
    wechatBridge: bridge && { ...bridge },
    ai: { apiKey: null, model: 'test-model' },
    authLimits: { attempts: 100, windowMs: 60_000 },
    trustForwardedFor: false,
    inputPolicyMode: 'observe',
  };
  database ??= await openDatabase('pglite://:memory:');
  runtime ??= await createRoomRuntime({
    database: database.db,
    inputPolicyMode: 'observe',
    generate: async () => {
      throw new Error('Authentication tests must not generate a match.');
    },
  });
  return createApp({ database: database.db, config, rooms: runtime });
}
