/**
 * Accounts, sessions and the auth boundary, observed from the browser.
 *
 * Two scenarios cover the session contract end to end: the lifecycle a player lives through
 * (register, refresh, sign out, refused sign-in, anonymous refusals) and what happens when the
 * session dies while a room socket is open (terminal close, no reconnect loop, sign in again).
 * Username/password/cookie/body and same-origin rules are unit-tested in `tests/unit/`.
 */
import { expect } from '@playwright/test';
import { test } from '../support/test';
import { WS_CLOSE, WS_PROTOCOL } from '../../shared/protocol';
import { gameApiBase } from '../../shared/release';
import { expireSessionsFor } from '../support/db';
import { TEST_AI_KEY } from '../support/harness';
import { fixture } from '../support/runtime';
import { apiJson, gameJson, selfIdentity, testReleaseId } from '../support/api';
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

test('注册建立会话、刷新保持登录、登出后失效；未登录时接口与房间连接都被拒绝', async ({
  browser,
}) => {
  const { context, page, username } = await signedInContext(browser, 'auth');

  // Identity stays independent of game availability; only game health reports model configuration.
  const session = await apiJson<{ user: unknown }>(context, '/api/session');
  const health = await gameJson<{ aiConfigured: boolean }>(context, '/health');
  expect(health.body.aiConfigured).toBe(true);
  expect(JSON.stringify(health.body)).not.toContain(TEST_AI_KEY);
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
  const socketPath = `${gameApiBase(testReleaseId())}/rooms/${roomId}/ws?release=${testReleaseId()}`;
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

  // The auth surface is a real form, and a refused sign-in is announced as text rather than only as
  // colour, leaving no session behind.
  await openAuth(page);
  const snapshot = await page.getByTestId('view-auth').ariaSnapshot();
  expect(snapshot).toMatch(/textbox/);
  expect(snapshot).toMatch(/button/);
  await page.getByTestId('auth-mode-login').click();
  await page.getByTestId('auth-username').fill(username);
  await page.getByTestId('auth-password').fill('definitely-not-the-password');
  await page.getByTestId('auth-submit').click();
  await expect.poll(() => visibleErrorText(page), { timeout: 20_000 }).not.toBe('');
  await expect(page.getByTestId('nav-username')).toBeHidden();
  expect((await apiJson(context, '/api/profile')).status).toBe(401);
  const liveRegions = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).filter(
        (element) => (element.textContent ?? '').trim().length > 0,
      ).length,
  );
  expect(liveRegions).toBeGreaterThan(0);

  // The same credentials still work after signing out.
  await signIn(page, username);
  expect((await apiJson(context, '/api/profile')).status).toBe(200);
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
  // signing in again restores a working session.
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
