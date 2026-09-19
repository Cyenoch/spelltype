/**
 * 从浏览器端观测的账号、会话与认证边界。
 *
 * 每次登录均走通真实的重定向链条：认证界面的链接将浏览器导向 `/api/auth/wechat/start`，
 * 测试脚手架将桥接域名路由至本地微信桥接替身（签发与真实对端服务相同的中继有效载荷），
 * 浏览器携带自身 Cookie 通过真实的回调返回。
 * 测试场景覆盖玩家经历的完整生命周期（登录、刷新、登出、匿名拒绝）、登录时携带的邀请信息、
 * 桥接故障、伪造的回调签名与令牌重放，以及房间 socket 打开期间会话失效时的行为。
 * 令牌密码学与状态账本行为在 `tests/unit/wechat-login.spec.ts` 中直接针对应用本身进行锁定。
 */
import { expect } from '@playwright/test';
import { test } from '../support/test';
import { WS_CLOSE, WS_PROTOCOL } from '../../shared/protocol';
import { expireSessionsFor } from '../support/db';
import { harness, TEST_AI_KEY } from '../support/harness';
import { fixture } from '../support/runtime';
import { apiJson, gameJson, selfIdentity } from '../support/api';
import { gotoApp, openHome, settle, visibleErrorText } from '../support/app';
import { createRoom, waitForLobbyPlayers } from '../support/lobby';
import {
  expectSignedOut,
  newContext,
  openAuth,
  signIn,
  signOut,
  signUp,
  signedInContext,
  uniqueName,
} from '../support/session';
import { captureCloseCodes } from '../support/wire';

test.beforeEach(async () => {
  await fixture().reset();
});

test('微信登录建立会话、刷新保持登录、登出后失效；未登录时接口与房间连接都被拒绝', async ({
  browser,
}) => {
  const { context, page, username } = await signedInContext(browser, 'auth');

  // 身份保持独立于游戏运行时；状态文档仅携带维护状态指针和描述性身份信息，绝不包含敏感机密。
  const session = await apiJson<{ user: unknown }>(context, '/api/session');
  const status = await apiJson<{ maintenance: { mode: string }; buildId: string }>(
    context,
    '/api/status',
  );
  expect(status.body.maintenance.mode).toBe('open');
  expect(JSON.stringify(status.body)).not.toContain(TEST_AI_KEY);
  expect(JSON.stringify(session.body)).not.toContain(TEST_AI_KEY);

  await page.reload();
  await expect(page.getByTestId('nav-username')).toHaveText(username);
  expect((await apiJson(context, '/api/profile')).status).toBe(200);

  const roomId = await createRoom(page, { theme: '准入试炼' });

  await signOut(page);
  await page.reload();
  await expectSignedOut(page);

  // 已登出的访客在所有接口上均被拒绝，包括真实房间的 socket，且未知的房间号绝不会变成可用房间。
  expect((await apiJson(context, '/api/profile')).status).toBe(401);
  expect((await gameJson(context, `/rooms/${roomId}`)).status).toBe(401);
  expect(
    (await gameJson(context, '/rooms', { method: 'POST', data: { theme: '无权限' } })).status,
  ).toBe(401);
  expect((await gameJson(context, '/match', { method: 'POST' })).status).toBe(401);
  expect(
    (await gameJson(context, '/rooms/0123456789abcdef01234567')).status,
  ).toBeGreaterThanOrEqual(400);
  const socketPath = `/api/rooms/${roomId}/ws`;
  const socketResult = await page.evaluate(
    ({ path, protocol }) =>
      new Promise<string>((resolve) => {
        // 显式提供当前的传输协议：此探针必须保持为鉴权拒绝测试，绝不能退化为协议失败测试。
        const socket = new WebSocket(`ws://${location.host}${path}`, protocol);
        socket.onopen = () => resolve('open');
        socket.onclose = (event) => resolve(`close:${event.code}`);
        socket.onerror = () => resolve('error');
        setTimeout(() => resolve('timeout'), 8000);
      }),
    { path: socketPath, protocol: WS_PROTOCOL },
  );
  expect(socketResult).toMatch(/^(?:error|close:)/);

  // 认证界面是单一的微信交接，而非凭据输入表单：链接指向应用自有的发起端点，
  // 因此由浏览器本身（而非任何脚本代码）执行登录跳转。
  await openAuth(page);
  const authView = page.getByTestId('view-auth');
  expect(await authView.ariaSnapshot()).not.toMatch(/textbox/);
  const loginLink = page.getByTestId('auth-wechat');
  await expect(loginLink).toBeVisible();
  await expect(loginLink).toHaveAttribute('href', /\/api\/auth\/wechat\/start/);

  // 登出后使用相同微信身份依然有效：相同账号，会话恢复。
  await signIn(page, username);
  expect((await apiJson(context, '/api/profile')).status).toBe(200);
  await context.close();
});

test('失败的登录把错误与邀请一起带回，重试成功后直达房间', async ({ browser }) => {
  const host = await signedInContext(browser, 'inv');
  const roomId = await createRoom(host.page, { theme: '登录邀请契约' });

  const guest = await newContext(browser);
  const guestPage = await guest.newPage();
  await gotoApp(guestPage, `/?room=${roomId}`);
  await expect(guestPage.getByTestId('view-auth')).toBeVisible();
  await expect(guestPage.getByTestId('invite-notice')).toContainText(roomId);

  // 桥接本身拒绝握手：回调必须降落到认证界面并提示明确错误，邀请信息依然保留，且无会话产生。
  const guestName = uniqueName('invited');
  harness().rewriteNextWechatRelay((destination) => {
    destination.searchParams.delete('token');
    destination.searchParams.set('wx_bridge_error', 'user_denied');
  });
  await guestPage.getByTestId('auth-wechat').click();
  await expect(guestPage.getByTestId('auth-error')).toBeVisible();
  const failure = new URL(guestPage.url());
  expect(failure.pathname).toBe('/auth');
  expect(failure.searchParams.get('error')).toBe('wechat_failed');
  expect(failure.searchParams.get('room')).toBe(roomId);
  expect((await apiJson<{ user: unknown }>(guest, '/api/session')).body.user).toBeNull();

  // 重试属于常规登录：邀请信息直接将玩家带入大厅。
  await signIn(guestPage, guestName);
  await expect(guestPage.getByTestId('lobby-panel')).toBeVisible();
  await waitForLobbyPlayers(guestPage, [host.username, guestName]);

  await guest.close();
  await host.context.close();
});

test('伪造的回调签名终止在错误提示，且不留下会话', async ({ browser }) => {
  const { context, page } = await signedInContext(browser, 'reject');
  await signOut(page);
  await openAuth(page);
  harness().rewriteNextWechatRelay((destination) => {
    const [body, signature] = (destination.searchParams.get('token') ?? '').split('.');
    if (!body || !signature) throw new Error('The fixture bridge did not issue a signed relay.');
    const forged = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    destination.searchParams.set('token', `${body}.${forged}`);
  });
  await page.getByTestId('auth-wechat').click();
  await expect(page.getByTestId('auth-error')).toBeVisible();
  const landed = new URL(page.url());
  expect(landed.pathname).toBe('/auth');
  expect(landed.searchParams.get('error')).toBe('wechat_failed');
  expect((await apiJson<{ user: unknown }>(context, '/api/session')).body.user).toBeNull();
  await context.close();
});

test('同一登录令牌只能换取一次会话：重放被拒绝', async ({ browser }) => {
  const context = await newContext(browser);
  const page = await context.newPage();
  const username = uniqueName('replay');
  let capturedToken: string | null = null;
  await openHome(page);
  harness().rewriteNextWechatRelay((destination) => {
    capturedToken = destination.searchParams.get('token');
  });
  await signUp(page, username);
  const spentToken = capturedToken;
  if (!spentToken) throw new Error('The successful login relay was not captured.');

  // 本次登录携带的令牌已被消费。登出并再次出示完全相同的令牌必须失败，
  // 不能为截获该令牌的人签发第二个有效会话。
  await signOut(page);
  await openAuth(page);
  harness().rewriteNextWechatRelay((destination) =>
    destination.searchParams.set('token', spentToken),
  );
  await page.getByTestId('auth-wechat').click();
  await expect(page.getByTestId('auth-error')).toBeVisible();
  expect(new URL(page.url()).searchParams.get('error')).toBe('wechat_failed');
  expect((await apiJson<{ user: unknown }>(context, '/api/session')).body.user).toBeNull();

  await context.close();
});

test('会话过期时服务端关闭房间连接且客户端不再重连，重新登录仍可用', async ({ browser }) => {
  test.setTimeout(300_000);
  const host = await newContext(browser);
  const hostPage = await host.newPage();
  const closeLog = await captureCloseCodes(hostPage);
  await openHome(hostPage);
  const hostName = uniqueName('sess');
  await signUp(hostPage, hostName);

  const roomId = await createRoom(hostPage, { theme: '会话过期契约' });
  const other = await signedInContext(browser, 'sess2');
  await gotoApp(other.page, `/?room=${roomId}`);
  await waitForLobbyPlayers(hostPage, [hostName, other.username]);

  // 活动连接携带握手时校验的过期时间，因此缩短会话并强制发起全新握手：
  // 服务端随后必须以会话过期状态码主动关闭 socket。
  const hostIdentity = await selfIdentity(host);
  await expireSessionsFor(hostIdentity.userId, 12_000);
  await hostPage.reload();
  await expect(hostPage.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 });

  await expect.poll(() => closeLog(), { timeout: 60_000 }).toContain(WS_CLOSE.sessionExpired);

  // 终态关闭不再重试：客户端绝不能陷入死循环重连。
  const afterClose = (await closeLog()).length;
  await settle(9000);
  expect((await closeLog()).length).toBe(afterClose);

  // 提示玩家重新登录，受保护的 API 已经拒绝会话，而重新登录（相同的微信身份）能够恢复正常可用的会话。
  await expect
    .poll(
      async () =>
        (await hostPage.getByTestId('view-auth').isVisible()) ||
        (await visibleErrorText(hostPage)).length > 0,
      { timeout: 20_000 },
    )
    .toBe(true);
  expect((await apiJson(host, '/api/profile')).status).toBe(401);
  await hostPage.reload();
  await expectSignedOut(hostPage);
  await signIn(hostPage, hostName);
  expect((await apiJson(host, '/api/profile')).status).toBe(200);

  await host.close();
  await other.context.close();
});
