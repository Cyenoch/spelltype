/**
 * Accounts, sessions and the auth boundary, observed from the browser.
 *
 * Every login walks the real redirect chain: the auth view's link hands the browser to
 * `/api/auth/wechat/start`, the harness routes the bridge hostname to the local WeChat bridge
 * double (which signs the same relay payloads the sibling service does), and the browser comes
 * back through the real callback with its own cookies. The scenarios cover the lifecycle a player
 * lives through (login, refresh, sign out, anonymous refusals), the invite that survives a login,
 * bridge failures, forged callback signatures and token replay, and what happens when a session
 * dies while a room socket is open.
 * Token crypto and state-ledger behaviour are pinned against the app directly in
 * `tests/unit/wechat-login.spec.ts`.
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

  // Identity stays independent of the game runtime; the status document carries
  // only the maintenance pointer and informational identity, never secrets.
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

  // A signed-out visitor is refused everywhere, including the room socket of a real room, and an
  // unknown room id never becomes a usable room.
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
        // The current wire protocol is offered explicitly: this probe must stay an
        // authentication-refusal test, never degenerate into a protocol-failure test.
        const socket = new WebSocket(`ws://${location.host}${path}`, protocol);
        socket.onopen = () => resolve('open');
        socket.onclose = (event) => resolve(`close:${event.code}`);
        socket.onerror = () => resolve('error');
        setTimeout(() => resolve('timeout'), 8000);
      }),
    { path: socketPath, protocol: WS_PROTOCOL },
  );
  expect(socketResult).toMatch(/^(?:error|close:)/);

  // The auth surface is a single WeChat handoff, not a credential form: the link points at the
  // app's own start endpoint, so the browser — not any script — performs the login navigation.
  await openAuth(page);
  const authView = page.getByTestId('view-auth');
  expect(await authView.ariaSnapshot()).not.toMatch(/textbox/);
  const loginLink = page.getByTestId('auth-wechat');
  await expect(loginLink).toBeVisible();
  await expect(loginLink).toHaveAttribute('href', /\/api\/auth\/wechat\/start/);

  // The same WeChat identity still works after signing out: same account, session restored.
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

  // The bridge itself refuses the handshake: the callback must land on the auth view with the
  // announced error, the invite still attached, and no session to show for it.
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

  // The retry is an ordinary login: the invite carries the player straight into the lobby.
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

  // The token this login carried is spent. Signing out and presenting the very same token again
  // must fail instead of minting a second session for whoever captured it.
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

  // A live connection carries the expiry that was validated at handshake time, so shorten
  // the session and force a fresh handshake: the server must then close the socket itself
  // with the session-expired code.
  const hostIdentity = await selfIdentity(host);
  await expireSessionsFor(hostIdentity.userId, 12_000);
  await hostPage.reload();
  await expect(hostPage.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 });

  await expect.poll(() => closeLog(), { timeout: 60_000 }).toContain(WS_CLOSE.sessionExpired);

  // A terminal close is not retried: the client must not sit in a reconnect loop.
  const afterClose = (await closeLog()).length;
  await settle(9000);
  expect((await closeLog()).length).toBe(afterClose);

  // The player is told to sign in again, the protected API is already refusing the session, and
  // signing in again — the same WeChat identity — restores a working session.
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
