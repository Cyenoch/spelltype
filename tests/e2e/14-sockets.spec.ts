/**
 * Spec 14 — connection lifecycle: an offline completion must not cast or lock before the
 * server acknowledges it, and server-initiated closes (4002 session expired, 4xxx room
 * closed) must surface to the player without a reconnect loop.
 */
import { expect, test } from '../support/test';
import { INITIAL_HEALTH, WS_CLOSE } from '../../shared/protocol';
import { openD1, runSql } from '../support/d1';
import { fixture, runtime } from '../support/runtime';
import {
  castState,
  completeSpell,
  completionDamage,
  inputValue,
  insertIntoField,
  roomSnapshot,
  seatHealth,
  selfSpellsCast,
  snapshotPlayer,
  spellText,
  typeText,
  typingInput,
  waitForCombat,
} from '../support/combat';
import {
  apiJson,
  captureCloseCodes,
  createRoom,
  gotoApp,
  newContext,
  openHome,
  selfIdentity,
  setReady,
  settle,
  signUp,
  signedInContext,
  startMatch,
  testId,
  twoPlayerRoom,
  uniqueName,
  visibleErrorText,
  waitForLobbyPlayers,
} from '../support/ui';

test.beforeEach(async () => {
  await fixture().reset();
  await fixture().scenario({ mode: 'success', difficulty: 'easy' });
});

test('离线完成不会在服务端确认前施法或锁定', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await twoPlayerRoom(browser, { theme: '离线契约', difficulty: 'easy' });
  const host = room.host.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(room.guest.page)]);
  const text = await spellText(host);

  // In a two-player room the only automatic target is the other seat, and both players start at
  // full health — so the guest's landing spot at the end is exactly `INITIAL_HEALTH` minus one
  // completion, which is what makes "damage was dealt exactly once" provable.
  expect(await seatHealth(host, guestIdentity.userId)).toEqual({ hp: INITIAL_HEALTH, maxHp: INITIAL_HEALTH });

  // What the player types while connected really reaches the room, so the offline half of the
  // spell is the only part the server has not seen.
  await typeText(host, text.slice(0, 4));
  await expect
    .poll(async () => snapshotPlayer(await roomSnapshot(room.guest.context, room.roomId), hostIdentity).progress, { timeout: 20_000 })
    .toBe(4);
  const before = await roomSnapshot(room.guest.context, room.roomId);
  const beforeHost = snapshotPlayer(before, hostIdentity);
  const beforeGuest = snapshotPlayer(before, guestIdentity);

  await room.host.context.setOffline(true);
  await expect
    .poll(async () => testId(host, 'connection-status').getAttribute('data-state'), { timeout: 30_000 })
    .toMatch(/closed|reconnecting/);

  // Finish the spell locally with the socket down. The field really holds the whole spell, yet
  // the client must neither cast nor lock before the server acknowledges the completion.
  await insertIntoField(host, text.slice(4));
  expect(await inputValue(host)).toBe(text);
  await settle(3000);

  expect(await castState(host)).not.toBe('done');
  await expect(typingInput(host)).toBeEditable();

  // The room — read through the opponent's own authenticated context, so this is the server's
  // view and not the disconnected client's — saw no completion at all: no cast, no damage, and
  // the target's health untouched.
  const during = await roomSnapshot(room.guest.context, room.roomId);
  const duringHost = snapshotPlayer(during, hostIdentity);
  expect(duringHost.progress).toBe(4);
  expect(duringHost.spellsCast).toBe(beforeHost.spellsCast);
  expect(duringHost.damageDealt).toBe(beforeHost.damageDealt);
  expect(duringHost.hp).toBe(beforeHost.hp);
  expect(snapshotPlayer(during, guestIdentity).hp).toBe(beforeGuest.hp);

  // Back online: the completion is only accepted once the server confirms it. A reconnect may
  // legitimately replace the draft with the server-accepted prefix, so drive the field from its
  // actual content and let the driver type only the missing suffix.
  await room.host.context.setOffline(false);
  await expect
    .poll(async () => testId(host, 'connection-status').getAttribute('data-state'), { timeout: 40_000 })
    .toBe('open');

  const restored = await inputValue(host);
  // Whatever was restored is a prefix of the authoritative spell: the room never accepted more.
  expect(text.startsWith(restored)).toBe(true);

  const completed = await completeSpell(host);
  // The stale offline completion did not consume the spell: the same one is finished here, so
  // the target loses exactly one completion's worth of health — never two.
  expect(completed).toBe(text);
  const damage = completionDamage(text);
  await expect
    .poll(async () => (await seatHealth(host, guestIdentity.userId)).hp, { timeout: 40_000 })
    .toBe(INITIAL_HEALTH - damage);
  const after = await roomSnapshot(room.guest.context, room.roomId);
  expect(snapshotPlayer(after, hostIdentity).damageDealt).toBe(damage);
  expect(await selfSpellsCast(host)).toBe(beforeHost.spellsCast + 1);

  await room.host.context.close();
  await room.guest.context.close();
});

test('会话过期时服务端以 4002 关闭连接且客户端不重连', async ({ browser }) => {
  test.setTimeout(300_000);
  const host = await newContext(browser);
  const hostPage = await host.newPage();
  const closeLog = await captureCloseCodes(hostPage);
  await openHome(hostPage);
  const hostName = uniqueName('sess');
  await signUp(hostPage, hostName);

  const roomId = await createRoom(hostPage, { theme: '会话过期契约', difficulty: 'easy' });
  const other = await signedInContext(browser, 'sess2');
  await gotoApp(other.page, `/?room=${roomId}`);
  await waitForLobbyPlayers(hostPage, [hostName, other.username]);

  // A live connection carries the expiry that was validated at handshake time, so shorten
  // the session and force a fresh handshake: the server must then close the socket itself
  // with the session-expired code.
  const db = await openD1(runtime().persistDir);
  // expires_at is epoch milliseconds; set it for this account only so the other participant's
  // session stays valid.
  const hostIdentity = await selfIdentity(host);
  await runSql(
    db,
    "UPDATE sessions SET expires_at = (CAST(strftime('%s','now') AS INTEGER) * 1000) + 12000 WHERE user_id = ?",
    [hostIdentity.userId],
  );
  await hostPage.reload();
  await expect(testId(hostPage, 'lobby-panel')).toBeVisible({ timeout: 30_000 });

  await expect.poll(() => closeLog(), { timeout: 60_000 }).toContain(WS_CLOSE.sessionExpired);

  const afterClose = (await closeLog()).length;
  await settle(9000);
  expect((await closeLog()).length).toBe(afterClose);

  // The player is told to sign in again instead of being silently disconnected.
  await expect
    .poll(
      async () => (await testId(hostPage, 'view-auth').isVisible()) || (await visibleErrorText(hostPage)).length > 0,
      { timeout: 20_000 },
    )
    .toBe(true);
  expect((await apiJson(host, '/api/profile')).status).toBe(401);

  await host.close();
  await other.context.close();
});

test('比赛房间被关闭时服务端关闭连接且不进入重连风暴', async ({ browser }) => {
  test.setTimeout(300_000);
  const first = await newContext(browser);
  const firstPage = await first.newPage();
  const closeLog = await captureCloseCodes(firstPage);
  await openHome(firstPage);
  await signUp(firstPage, uniqueName('close1'));
  const second = await signedInContext(browser, 'close2');

  await apiJson(second.context, '/api/match', { method: 'POST', data: { difficulty: 'normal' } });
  const ticket = await apiJson<{ state: string; roomId?: string }>(first, '/api/match', { method: 'POST', data: { difficulty: 'normal' } });
  expect(ticket.body.state).toBe('matched');
  const roomId = ticket.body.roomId!;

  await gotoApp(firstPage, `/?room=${roomId}`);
  await expect(testId(firstPage, 'lobby-panel')).toBeVisible({ timeout: 30_000 });
  await expect(testId(firstPage, 'battle-panel')).toBeHidden();

  // The other participant cancels the pre-match reservation: the room goes away.
  expect((await apiJson<{ cancelled: boolean }>(second.context, '/api/match', { method: 'DELETE' })).body.cancelled).toBe(true);

  // A cancelled reservation is a terminal room close, not a transient drop.
  await expect.poll(() => closeLog(), { timeout: 40_000 }).toContain(WS_CLOSE.closed);
  const afterClose = (await closeLog()).length;
  await settle(9000);
  expect((await closeLog()).length).toBe(afterClose);

  // The observable claim is structural, not a wording pin: the battle panel stays hidden and the
  // room's terminal problem pane is shown with the server's own reason (which may legitimately be
  // the non-generic one, e.g. a cancelled matchmaking reservation). The close category itself is
  // already proven by the WS_CLOSE.closed and no-reconnect assertions above.
  await expect(testId(firstPage, 'battle-panel')).toBeHidden();
  await expect(testId(firstPage, 'room-error')).toBeVisible({ timeout: 30_000 });
  await expect(testId(firstPage, 'room-error')).not.toBeEmpty();

  await first.close();
  await second.context.close();
});

test('用会话接口登出后服务端以 4002 关闭房间连接，其他账号的对局不受影响', async ({ browser }) => {
  test.setTimeout(300_000);
  // The close-code listener must be installed before the page's first navigation, because the room
  // socket is created as soon as the app enters the room.
  const hostContext = await newContext(browser);
  const hostPage = await hostContext.newPage();
  const closeLog = await captureCloseCodes(hostPage);
  await openHome(hostPage);
  const hostName = await (async () => {
    const name = uniqueName('logout');
    await signUp(hostPage, name);
    return name;
  })();
  const roomId = await createRoom(hostPage, { theme: '登出契约', difficulty: 'hard' });
  const guest = await signedInContext(browser, 'logout2');
  await gotoApp(guest.page, `/?room=${roomId}`);
  await waitForLobbyPlayers(hostPage, [hostName, guest.username]);
  await setReady(guest.page, true);
  await startMatch(hostPage);
  await Promise.all([waitForCombat(hostPage), waitForCombat(guest.page)]);
  const hostIdentity = await selfIdentity(hostContext);

  // The session is revoked through the API on the browser's own session (no UI click, which would
  // tear the socket down for its own reasons and hide the bug).
  const logout = await apiJson<{ ok: boolean }>(hostContext, '/api/logout', { method: 'POST' });
  expect(logout.status).toBe(200);

  await expect.poll(() => closeLog(), { timeout: 40_000 }).toContain(WS_CLOSE.sessionExpired);
  // A revoked session is terminal: the client must not sit in a reconnect loop.
  const afterClose = (await closeLog()).length;
  await settle(6000);
  expect((await closeLog()).length).toBe(afterClose);

  // No private feed authority is left: neither the room snapshot nor a fresh socket handshake.
  expect((await apiJson(hostContext, `/api/rooms/${roomId}`)).status).toBe(401);
  const handshake = await hostPage.evaluate(
    (id) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`ws://${location.host}/api/rooms/${id}/ws`);
        socket.onopen = () => {
          socket.close();
          resolve('open');
        };
        socket.onerror = () => resolve('refused');
        socket.onclose = () => resolve('refused');
        setTimeout(() => resolve('timeout'), 8000);
      }),
    roomId,
  );
  expect(handshake).toBe('refused');

  // The other account keeps its seat and its authority: its completed spell still lands on the
  // revoked player's seat, so the room itself was never disrupted.
  const text = await spellText(guest.page);
  const hostHpBefore = (await seatHealth(guest.page, hostIdentity.userId)).hp;
  expect(hostHpBefore).toBe(INITIAL_HEALTH);
  expect(await completeSpell(guest.page)).toBe(text);
  await expect
    .poll(async () => (await seatHealth(guest.page, hostIdentity.userId)).hp, { timeout: 30_000 })
    .toBe(hostHpBefore - completionDamage(text));

  await hostContext.close();
  await guest.context.close();
});
