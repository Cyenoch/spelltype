/**
 * Spec 11 — result persistence: a failed write is never reported as saved, the retry survives a
 * process restart and still records one match exactly once, a rematch starts a new match without
 * touching the previous record, and the stored data is survival combat data only.
 *
 * Fault injection renames the `results` table in the isolated local D1 file. That file is owned by
 * the test harness (never a public test endpoint), which is why the fault lives here.
 */
import { expect, test } from '../support/test';
import { DAMAGE_PER_CHARACTER, INITIAL_HEALTH, type RoomSnapshot } from '../../shared/protocol';
import { openD1, querySql, runSql, type D1FileHandle } from '../support/d1';
import { fixture, restartInstance, runtime } from '../support/runtime';
import { battleMatchId, endReason, finalRows, playUntilFinished, saveStatus, spellText, waitForCombat } from '../support/combat';
import {
  accuracyPercent,
  apiJson,
  gotoApp,
  historyRows,
  openProfile,
  rowFor,
  selfIdentity,
  setReady,
  startMatch,
  testId,
  twoPlayerRoom,
  waitForProfileLoaded,
} from '../support/ui';

test.beforeEach(async () => {
  await fixture().reset();
  await fixture().scenario({ mode: 'success' });
});

/** Every object key reachable in a JSON value, so a removed field cannot hide in a nested place. */
function collectKeys(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  for (const [key, nested] of Object.entries(value)) {
    found.add(key);
    collectKeys(nested, found);
  }
  return found;
}

/** Fields of the retired five-round game that must not survive anywhere in the live contract. */
const REMOVED_FIELDS = ['round', 'totalRounds', 'roundPoints', 'finishedAt', 'format', 'score', 'intermission'];

async function tableColumns(db: D1FileHandle, table: string): Promise<string[]> {
  const rows = await querySql<{ name: string }>(db, `SELECT name FROM pragma_table_info('${table}')`);
  return rows.map((row) => row.name);
}

test('保存失败不谎称已同步，恢复并重启后重试只计一场', async ({ browser }) => {
  test.setTimeout(700_000);
  const room = await twoPlayerRoom(browser, { theme: '持久化契约', difficulty: 'hard' });
  const host = room.host;
  const hostIdentity = await selfIdentity(host.context);
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(room.guest.page)]);
  const liveMatchId = await battleMatchId(host.page);

  // Damage the sink before the match can settle, so the first settlement attempt really fails.
  const db = await openD1(runtime().persistDir);
  expect(await db.tableExists('results')).toBe(true);
  await runSql(db, 'ALTER TABLE results RENAME TO results_e2e_backup');
  expect(await db.tableExists('results')).toBe(false);

  try {
    // The opponent idles while the host plays the match out.
    await playUntilFinished(host.page);
    expect(await endReason(host.page)).toBe('elimination');
    // The write really fails, and the UI says so instead of claiming a sync.
    await expect.poll(() => saveStatus(host.page), { timeout: 120_000 }).toBe('error');
  } finally {
    // The injected fault must never outlive this test, wherever it failed above.
    if (await db.tableExists('results_e2e_backup')) await runSql(db, 'ALTER TABLE results_e2e_backup RENAME TO results');
  }
  expect(await db.tableExists('results')).toBe(true);

  // The unsettled match is held by the room, so a process restart must not lose it: the room comes
  // back, retries the same write and still records exactly one row.
  await restartInstance('app');
  await gotoApp(host.page, `/?room=${room.roomId}`);
  await expect.poll(() => saveStatus(host.page), { timeout: 180_000 }).toBe('saved');

  const settledRows = await querySql<{ damage_dealt: number; hp_remaining: number; spells_cast: number; correct_chars: number }>(
    db,
    'SELECT damage_dealt, hp_remaining, spells_cast, correct_chars FROM results WHERE match_id = ? AND user_id = ?',
    [liveMatchId, hostIdentity.userId],
  );
  expect(settledRows).toHaveLength(1);
  expect(settledRows[0].damage_dealt).toBe(INITIAL_HEALTH);
  expect(settledRows[0].hp_remaining).toBe(INITIAL_HEALTH);
  expect(settledRows[0].spells_cast).toBeGreaterThan(0);
  // Confirmed characters cover every character of every completed spell, so they can never be fewer
  // than the damage dealt divided by the per-character rate (the final blow is bounded by health).
  expect(settledRows[0].correct_chars).toBeGreaterThanOrEqual(INITIAL_HEALTH / DAMAGE_PER_CHARACTER);
  const total = await querySql<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM results WHERE user_id = ?', [hostIdentity.userId]);
  expect(total[0].count).toBe(1);
  const perPlayer = await querySql<{ count: number }>(
    db,
    'SELECT COUNT(*) AS count FROM results WHERE match_id = ? AND user_id = ?',
    [liveMatchId, hostIdentity.userId],
  );
  expect(perPlayer[0].count).toBe(1);

  await openProfile(host.page);
  const history = await historyRows(host.page);
  expect(history.filter((row) => row.matchId === liveMatchId)).toHaveLength(1);
  expect(history.find((row) => row.matchId === liveMatchId)!.damage).toBe(INITIAL_HEALTH);

  await host.context.close();
  await room.guest.context.close();
});

test('重复结算与再来一局不会重复计场，聚合值与日志一致', async ({ browser }) => {
  test.setTimeout(700_000);
  const room = await twoPlayerRoom(browser, { theme: '再来一局契约', difficulty: 'hard' });
  const host = room.host;
  const guest = room.guest;
  const hostIdentity = await selfIdentity(host.context);
  const guestIdentity = await selfIdentity(guest.context);

  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guest.page)]);
  const firstMatchId = await battleMatchId(host.page);
  const firstSpell = await spellText(host.page);
  await playUntilFinished(host.page);
  expect(await endReason(host.page)).toBe('elimination');

  const firstRows = await finalRows(host.page);
  const firstHostRow = rowFor(firstRows, hostIdentity)!;
  const firstGuestRow = rowFor(firstRows, guestIdentity)!;
  await expect.poll(() => saveStatus(host.page), { timeout: 60_000 }).toBe('saved');

  const db = await openD1(runtime().persistDir);
  const rowsAfterFirst = await querySql<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM results WHERE user_id = ?', [hostIdentity.userId]);
  expect(rowsAfterFirst[0].count).toBe(1);

  // Reconnecting to the settled match must not settle it a second time.
  await gotoApp(host.page, `/?room=${room.roomId}`);
  await expect(testId(host.page, 'final-panel')).toBeVisible({ timeout: 30_000 });
  const reconnected = await apiJson<RoomSnapshot>(host.context, `/api/rooms/${room.roomId}`);
  expect(reconnected.body.matchId).toBe(firstMatchId);
  expect(reconnected.body.endReason).toBe('elimination');
  const rowsAfterReconnect = await querySql<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM results WHERE user_id = ?', [hostIdentity.userId]);
  expect(rowsAfterReconnect[0].count).toBe(1);

  // The persisted row is the per-match aggregate, and it agrees with the panel the players saw.
  const stored = await querySql<{
    theme: string;
    damage_dealt: number;
    hp_remaining: number;
    spells_cast: number;
    correct_chars: number;
    duration_ms: number;
    rank: number;
    cpm: number;
    accuracy: number;
  }>(
    db,
    'SELECT theme, damage_dealt, hp_remaining, spells_cast, correct_chars, duration_ms, rank, cpm, accuracy FROM results WHERE match_id = ? AND user_id = ?',
    [firstMatchId, hostIdentity.userId],
  );
  expect(stored).toHaveLength(1);
  const record = stored[0];
  expect(record.theme).toContain('再来一局契约');
  expect(record.damage_dealt).toBe(firstHostRow.damage);
  expect(record.damage_dealt).toBe(INITIAL_HEALTH);
  expect(record.hp_remaining).toBe(firstHostRow.hp);
  expect(record.spells_cast).toBe(firstHostRow.spells);
  expect(record.correct_chars).toBeGreaterThanOrEqual(INITIAL_HEALTH / DAMAGE_PER_CHARACTER);
  expect(record.rank).toBe(firstHostRow.rank);
  expect(record.duration_ms).toBeGreaterThan(0);
  // CPM is the per-match aggregate over the active combat window, so it must match the stored
  // characters and duration (a one-unit tolerance covers the stored integer rounding).
  const aggregateCpm = record.correct_chars / (record.duration_ms / 60_000);
  expect(Math.abs(record.cpm - aggregateCpm)).toBeLessThanOrEqual(2);
  expect(record.cpm).toBe(firstHostRow.cpm);
  // The opponent was eliminated by exactly this player's damage, so the loser's row is its mirror.
  const storedGuest = await querySql<{ damage_dealt: number; hp_remaining: number; rank: number; correct_chars: number; accuracy: number }>(
    db,
    'SELECT damage_dealt, hp_remaining, rank, correct_chars, accuracy FROM results WHERE match_id = ? AND user_id = ?',
    [firstMatchId, guestIdentity.userId],
  );
  expect(storedGuest[0].damage_dealt).toBe(firstGuestRow.damage);
  expect(storedGuest[0].damage_dealt).toBe(0);
  expect(storedGuest[0].hp_remaining).toBe(0);
  expect(storedGuest[0].rank).toBe(firstGuestRow.rank);
  expect(storedGuest[0].correct_chars).toBe(0);

  await openProfile(host.page);
  const firstHistory = await historyRows(host.page);
  const firstEntry = firstHistory.find((row) => row.matchId === firstMatchId)!;
  expect(firstEntry.rank).toBe(firstHostRow.rank);
  expect(firstEntry.damage).toBe(firstHostRow.damage);
  expect(firstEntry.hp).toBe(firstHostRow.hp);
  expect(firstEntry.spells).toBe(firstHostRow.spells);

  // Rematch: the room returns to the lobby with a new match, so the previous record is untouched
  // and no row exists for the new match while it is still running.
  await gotoApp(host.page, `/?room=${room.roomId}`);
  await expect(testId(host.page, 'final-panel')).toBeVisible({ timeout: 30_000 });
  await testId(host.page, 'rematch').click();
  await expect(testId(host.page, 'lobby-panel')).toBeVisible({ timeout: 30_000 });
  await expect(testId(guest.page, 'lobby-panel')).toBeVisible({ timeout: 30_000 });
  await expect(testId(host.page, 'battle-panel')).toBeHidden();
  await setReady(guest.page, true);
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guest.page)]);

  const secondMatchId = await battleMatchId(host.page);
  expect(secondMatchId).not.toBe(firstMatchId);
  expect(await spellText(host.page)).not.toBe(firstSpell);
  const rowsDuringRematch = await querySql<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM results WHERE user_id = ?', [hostIdentity.userId]);
  expect(rowsDuringRematch[0].count).toBe(1);
  const rematchRows = await querySql<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM results WHERE match_id = ?', [secondMatchId]);
  expect(rematchRows[0].count).toBe(0);

  // Finishing the rematch adds exactly one record and leaves the first one alone.
  await playUntilFinished(host.page);
  await expect.poll(() => saveStatus(host.page), { timeout: 60_000 }).toBe('saved');
  const rowsAfterSecond = await querySql<{ count: number }>(db, 'SELECT COUNT(*) AS count FROM results WHERE user_id = ?', [hostIdentity.userId]);
  expect(rowsAfterSecond[0].count).toBe(2);
  const firstStillThere = await querySql<{ rank: number; damage_dealt: number }>(
    db,
    'SELECT rank, damage_dealt FROM results WHERE match_id = ? AND user_id = ?',
    [firstMatchId, hostIdentity.userId],
  );
  expect(firstStillThere).toHaveLength(1);
  expect(firstStillThere[0].damage_dealt).toBe(record.damage_dealt);
  expect(firstStillThere[0].rank).toBe(record.rank);

  await openProfile(host.page);
  const history = await historyRows(host.page);
  expect(history.filter((row) => row.matchId === firstMatchId)).toHaveLength(1);
  expect(history.filter((row) => row.matchId === secondMatchId)).toHaveLength(1);
  expect(history.find((row) => row.matchId === firstMatchId)!.rank).toBe(record.rank);

  await host.context.close();
  await guest.context.close();
});

test('结果表与线上契约只保留生存数据，回合制字段不再存在', async ({ browser }) => {
  test.setTimeout(500_000);
  const room = await twoPlayerRoom(browser, { theme: '契约清理', difficulty: 'hard' });
  const host = room.host;
  const guest = room.guest;
  const hostIdentity = await selfIdentity(host.context);
  const guestIdentity = await selfIdentity(guest.context);
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guest.page)]);
  const liveMatchId = await battleMatchId(host.page);

  // The live wire contract carries no round-era field anywhere, at any depth.
  const live = await apiJson<RoomSnapshot>(host.context, `/api/rooms/${room.roomId}`);
  const liveKeys = collectKeys(live.body);
  for (const removed of REMOVED_FIELDS) expect(liveKeys.has(removed), `live snapshot still carries "${removed}"`).toBe(false);

  await playUntilFinished(host.page);
  expect(await endReason(host.page)).toBe('elimination');
  await expect.poll(() => saveStatus(host.page), { timeout: 60_000 }).toBe('saved');

  // The stored row is survival data only: the combat columns exist and are filled, and the round
  // era's columns are gone from the table rather than left behind as legacy variants.
  const db = await openD1(runtime().persistDir);
  const columns = await tableColumns(db, 'results');
  for (const required of [
    'match_id',
    'user_id',
    'theme',
    'damage_dealt',
    'hp_remaining',
    'spells_cast',
    'correct_chars',
    'duration_ms',
    'rank',
    'cpm',
    'accuracy',
    'created_at',
  ]) {
    expect(columns, `results is missing ${required}`).toContain(required);
  }
  for (const removed of ['format', 'score']) expect(columns, `results still carries ${removed}`).not.toContain(removed);

  // The survival schema: every combat column is NOT NULL, only the accuracy figure may be null.
  const stored = await querySql<{
    match_id: string;
    user_id: string;
    theme: string;
    damage_dealt: number;
    hp_remaining: number;
    spells_cast: number;
    correct_chars: number;
    duration_ms: number;
    rank: number;
    cpm: number;
    accuracy: number | null;
    created_at: number;
  }>(
    db,
    'SELECT match_id, user_id, theme, damage_dealt, hp_remaining, spells_cast, correct_chars, duration_ms, rank, cpm, accuracy, created_at FROM results WHERE match_id = ?',
    [liveMatchId],
  );
  expect(stored).toHaveLength(2);
  const winner = stored.find((row) => row.user_id === hostIdentity.userId)!;
  const loser = stored.find((row) => row.user_id === guestIdentity.userId)!;
  expect(winner.match_id).toBe(liveMatchId);
  expect(winner.rank).toBe(1);
  expect(loser.rank).toBe(2);
  expect(winner.theme).toBe('契约清理');
  expect(winner.damage_dealt).toBe(INITIAL_HEALTH);
  expect(winner.hp_remaining).toBe(INITIAL_HEALTH);
  expect(winner.spells_cast).toBeGreaterThan(0);
  expect(winner.correct_chars).toBeGreaterThanOrEqual(INITIAL_HEALTH / DAMAGE_PER_CHARACTER);
  expect(winner.duration_ms).toBeGreaterThan(0);
  expect(winner.cpm).toBeGreaterThan(0);
  expect(winner.accuracy).not.toBeNull();
  // The stored figure is the same accuracy the players saw, whether it is kept as a ratio or a
  // percentage: a clean run is perfect.
  expect(accuracyPercent(winner.accuracy!)).toBe(100);
  expect(winner.created_at).toBeGreaterThan(0);
  expect(loser.damage_dealt).toBe(0);
  expect(loser.hp_remaining).toBe(0);
  expect(loser.spells_cast).toBe(0);
  expect(loser.correct_chars).toBe(0);
  expect(loser.cpm).toBe(0);
  expect(loser.duration_ms).toBeGreaterThan(0);

  // The history the API and the profile render is the same survival row, with no round-era variant.
  const profile = await apiJson<{
    stats: { games: number; wins: number; bestCpm: number };
    history: Record<string, unknown>[];
  }>(host.context, '/api/profile');
  expect(profile.status).toBe(200);
  expect(profile.body.history).toHaveLength(1);
  const profileKeys = collectKeys(profile.body);
  for (const removed of REMOVED_FIELDS) expect(profileKeys.has(removed), `profile still carries "${removed}"`).toBe(false);
  const apiRow = profile.body.history[0];
  expect(apiRow.match_id).toBe(liveMatchId);
  expect(apiRow.damage_dealt).toBe(INITIAL_HEALTH);
  expect(apiRow.hp_remaining).toBe(INITIAL_HEALTH);
  expect(apiRow.rank).toBe(1);
  expect(profile.body.stats).toEqual({ games: 1, wins: 1, bestCpm: winner.cpm });

  await openProfile(host.page);
  await waitForProfileLoaded(host.page);
  const rows = await historyRows(host.page);
  expect(rows).toHaveLength(1);
  expect(rows[0].matchId).toBe(liveMatchId);
  expect(rows[0].theme).toBe('契约清理');
  expect(rows[0].damage).toBe(INITIAL_HEALTH);
  expect(rows[0].hp).toBe(INITIAL_HEALTH);
  expect(rows[0].spells).toBe(winner.spells_cast);
  expect(rows[0].rank).toBe(1);
  expect(rows[0].cpm).toBe(winner.cpm);
  expect(rows[0].accuracy).toMatch(/100/);
  expect(rows[0].created.length).toBeGreaterThan(0);

  await host.context.close();
  await guest.context.close();
});
