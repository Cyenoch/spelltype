/**
 * Spec 3 — room capacity, admission rules, list locking, duplicate connections, and the
 * four-player combat result the room persists.
 */
import { expect, test } from '../support/test';
import { INITIAL_HEALTH, WS_CLOSE, type RoomSnapshot } from '../../shared/protocol';
import { openD1, querySql } from '../support/d1';
import { fixture, runtime } from '../support/runtime';
import {
  battleMatchId,
  endReason,
  finalRows,
  playUntilFinished,
  seatHealth,
  seatIsOut,
  waitForCombat,
  waitForMatchEnd,
} from '../support/combat';
import {
  apiJson,
  captureCloseCodes,
  createRoom,
  gotoApp,
  newContext,
  occupiedSeat,
  occupiedSeats,
  openHome,
  rowFor,
  selfIdentity,
  setReady,
  settle,
  signUp,
  signedInContext,
  startMatch,
  testId,
  uniqueName,
  visibleErrorText,
  waitForLobbyPlayers,
  type Session,
} from '../support/ui';

test.beforeEach(async () => {
  await fixture().reset();
  // No difficulty: the fixture follows the length band stated in the room's own prompt.
  await fixture().scenario({ mode: 'success' });
});

test('私人房容纳四名玩家，第五人无法加入，开局锁定名单且重复连接不占额外席位', async ({ browser }) => {
  // Three seats have to be eliminated by real completions, so the match itself needs the time.
  test.setTimeout(600_000);
  const host = await signedInContext(browser, 'cap0');
  // Hard spells deal ~176 damage each, so the host can really finish three 2400 HP opponents.
  const roomId = await createRoom(host.page, { theme: '四席试炼', difficulty: 'hard' });
  const others = [] as Session[];
  for (const index of [1, 2, 3]) others.push(await signedInContext(browser, `cap${index}`));

  for (const other of others) {
    await gotoApp(other.page, `/?room=${roomId}`);
    await expect(testId(other.page, 'lobby-panel')).toBeVisible();
  }
  const names = [host.username, ...others.map((other) => other.username)];
  await waitForLobbyPlayers(host.page, names);
  expect(await occupiedSeats(host.page).count()).toBe(4);

  // Fifth player: a full room must be refused with a visible explanation.
  const fifth = await signedInContext(browser, 'cap4');
  await gotoApp(fifth.page, `/?room=${roomId}`);
  await expect.poll(() => visibleErrorText(fifth.page), { timeout: 20_000 }).not.toBe('');
  await expect(testId(fifth.page, 'lobby-panel')).toBeHidden();
  expect(await occupiedSeats(host.page).count()).toBe(4);

  // The same account opening a second connection keeps one seat.
  const duplicatePage = await others[0].context.newPage();
  await gotoApp(duplicatePage, `/?room=${roomId}`);
  await expect(testId(duplicatePage, 'lobby-panel')).toBeVisible();
  expect(await occupiedSeats(host.page).count()).toBe(4);
  await others[0].page.close();
  await expect(occupiedSeat(host.page, others[0].username)).toHaveAttribute('data-connected', 'true');
  expect(await occupiedSeats(host.page).count()).toBe(4);

  for (const other of others.slice(1)) await setReady(other.page, true);
  await setReady(duplicatePage, true);
  await startMatch(host.page);
  for (const other of others.slice(1)) await expect(testId(other.page, 'battle-panel')).toBeVisible({ timeout: 30_000 });
  await expect(testId(duplicatePage, 'battle-panel')).toBeVisible({ timeout: 30_000 });

  // A started match refuses new participants, and keeps its four-player list.
  const sixth = await signedInContext(browser, 'cap5');
  await gotoApp(sixth.page, `/?room=${roomId}`);
  await expect.poll(() => visibleErrorText(sixth.page), { timeout: 20_000 }).not.toBe('');
  await expect(testId(sixth.page, 'lobby-panel')).toBeHidden();

  // A member refreshing rejoins the same seat and never adds a fifth player: the arena renders one
  // seat per participant, so four seats is the whole roster.
  await duplicatePage.reload();
  await expect(testId(duplicatePage, 'battle-panel')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => testId(duplicatePage, 'arena-seat').count(), { timeout: 20_000 }).toBe(4);

  // The four real participants fight one continuous match. Only the host plays, so the room eliminates
  // the three idle seats one at a time (its target is the next alive seat clockwise) and the final
  // ordering is unambiguous: rank 1 is the last player standing, and the eliminated seats are ranked
  // by elimination time, so the seat that fell last ranks highest among them.
  const pages = [host.page, duplicatePage, others[1].page, others[2].page];
  const identities = await Promise.all([
    selfIdentity(host.context),
    selfIdentity(others[0].context),
    selfIdentity(others[1].context),
    selfIdentity(others[2].context),
  ]);
  const matchIdValue = await battleMatchId(pages[0]);
  expect(matchIdValue).toMatch(/^[0-9a-f-]{8,}$/);
  await Promise.all(pages.map((page) => waitForCombat(page)));

  expect(await playUntilFinished(pages[0])).toBeGreaterThan(0);
  await Promise.all(pages.map((page) => waitForMatchEnd(page)));
  expect(await endReason(pages[0])).toBe('elimination');

  const rows = await finalRows(pages[0]);
  expect(rows).toHaveLength(4);
  expect(rows.map((row) => row.rank).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);

  const hostRow = rowFor(rows, identities[0])!;
  expect(hostRow.rank).toBe(1);
  expect(hostRow.damage).toBeGreaterThan(0);
  // Nobody ever attacked the host, so it kept its full health and out-damaged every other seat.
  expect(hostRow.hp).toBe(INITIAL_HEALTH);
  expect(await seatIsOut(pages[0], identities[0].userId)).toBe(false);
  for (const identity of identities.slice(1)) expect(hostRow.damage).toBeGreaterThan(rowFor(rows, identity)!.damage);

  const eliminatedRanks = [4, 3, 2];
  for (const [index, identity] of identities.slice(1).entries()) {
    const row = rowFor(rows, identity)!;
    expect(row.hp).toBe(0);
    expect(row.spells).toBe(0);
    expect(row.damage).toBe(0);
    expect(row.rank).toBe(eliminatedRanks[index]);
    // The arena marks the fallen seat as out, both on the host's view and on the seat's own page.
    expect(await seatIsOut(pages[0], identity.userId)).toBe(true);
    expect((await seatHealth(pages[0], identity.userId)).hp).toBe(0);
    expect(await seatIsOut(pages[index + 1], identity.userId)).toBe(true);
  }

  for (const page of pages) await expect(testId(page, 'save-status')).toHaveAttribute('data-state', 'saved', { timeout: 60_000 });

  const db = await openD1(runtime().persistDir);
  // The results table is combat-only now: the retired round game's `score` and `format` columns are
  // gone rather than kept around for old rows.
  const columns = await querySql<{ name: string }>(db, "SELECT name FROM pragma_table_info('results')");
  expect(columns.map((column) => column.name)).not.toContain('score');
  expect(columns.map((column) => column.name)).not.toContain('format');

  const saved = await querySql<{
    user_id: string;
    rank: number;
    damage_dealt: number;
    hp_remaining: number;
    spells_cast: number;
    correct_chars: number;
    duration_ms: number;
  }>(
    db,
    'SELECT user_id, rank, damage_dealt, hp_remaining, spells_cast, correct_chars, duration_ms FROM results WHERE match_id = ?',
    [matchIdValue],
  );
  expect(saved).toHaveLength(4);
  // One match, one duration: every row of this match carries the same total match length.
  expect(new Set(saved.map((row) => row.duration_ms)).size).toBe(1);
  for (const [index, identity] of identities.entries()) {
    const persisted = saved.find((row) => row.user_id === identity.userId)!;
    const row = rowFor(rows, identity)!;
    expect(persisted.rank).toBe(row.rank);
    expect(persisted.damage_dealt).toBe(row.damage);
    expect(persisted.hp_remaining).toBe(row.hp);
    expect(persisted.spells_cast).toBe(row.spells);
    expect(persisted.duration_ms).toBeGreaterThan(0);
    // Only the host typed anything, so only its row counts confirmed characters.
    if (index === 0) expect(persisted.correct_chars).toBeGreaterThan(0);
    else expect(persisted.correct_chars).toBe(0);
  }

  await host.context.close();
  for (const other of others.slice(1)) await other.context.close();
  await others[0].context.close();
  await duplicatePage.context().close();
  await fifth.context.close();
  await sixth.context.close();
});

test('未知房间标识不会创建新房间', async ({ browser }) => {
  const { context, page } = await signedInContext(browser, 'unknown');
  await openHome(page);
  await gotoApp(page, '/?room=ffffffffffffffffffffffff');
  await expect.poll(() => visibleErrorText(page), { timeout: 20_000 }).not.toBe('');
  await expect(testId(page, 'lobby-panel')).toBeHidden();

  const guest = await newContext(browser);
  const guestPage = await guest.newPage();
  const name = uniqueName('ghost');
  await gotoApp(guestPage, '/?room=ffffffffffffffffffffffff');
  await signUp(guestPage, name);
  await expect.poll(() => visibleErrorText(guestPage), { timeout: 20_000 }).not.toBe('');
  await expect(testId(guestPage, 'lobby-panel')).toBeHidden();

  await guest.close();
  await context.close();
});

test('被替换的旧连接无法再改动席位状态', async ({ browser }) => {
  test.setTimeout(240_000);
  // Raw room clients keep the seat semantics observable without the app's own reconnect.
  const context = await newContext(browser);
  const page = await context.newPage();
  const closeLog = await captureCloseCodes(page);
  await openHome(page);
  await signUp(page, uniqueName('seat'));
  const identity = await selfIdentity(context);

  const created = await apiJson<{ roomId: string }>(context, '/api/rooms', { method: 'POST', data: { theme: '席位契约', difficulty: 'easy' } });
  expect(created.status).toBe(200);
  const roomId = created.body.roomId;
  const ready = async () => {
    const snapshot = await apiJson<RoomSnapshot>(context, `/api/rooms/${roomId}`);
    return snapshot.body.players.find((player) => player.id === identity.userId)?.ready ?? null;
  };

  await page.evaluate((id) => {
    const first = new WebSocket(`ws://${location.host}/api/rooms/${id}/ws`);
    (window as unknown as { __seat: { first?: WebSocket } }).__seat = { first };
    first.onopen = () => first.send(JSON.stringify({ type: 'ready', ready: true }));
  }, roomId);
  await expect.poll(ready, { timeout: 30_000 }).toBe(true);

  // A second connection for the same account takes the seat and closes the first with the
  // documented "replaced" code.
  await page.evaluate((id) => {
    const second = new WebSocket(`ws://${location.host}/api/rooms/${id}/ws`);
    (window as unknown as { __seat: { second?: WebSocket } }).__seat.second = second;
    second.onopen = () => second.send(JSON.stringify({ type: 'ready', ready: false }));
  }, roomId);
  await expect.poll(ready, { timeout: 30_000 }).toBe(false);
  await expect.poll(() => closeLog(), { timeout: 30_000 }).toContain(WS_CLOSE.replaced);

  // In-flight actions on the replaced socket must not touch the seat afterwards.
  const sendResult = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const first = (window as unknown as { __seat: { first?: WebSocket } }).__seat.first;
        if (!first) {
          resolve('missing');
          return;
        }
        try {
          for (let index = 0; index < 5; index += 1) first.send(JSON.stringify({ type: 'ready', ready: true }));
        } catch {
          resolve('send-failed');
          return;
        }
        setTimeout(() => resolve('sent'), 200);
      }),
  );
  // Give the replaced socket's in-flight frames time to arrive before reading the seat again.
  await settle(2000);

  expect(await ready()).toBe(false);
  const after = await apiJson<RoomSnapshot>(context, `/api/rooms/${roomId}`);
  expect(after.body.players).toHaveLength(1);
  expect(after.body.players.filter((player) => player.id === identity.userId)).toHaveLength(1);
  expect(['sent', 'send-failed']).toContain(sendResult);

  await context.close();
});
