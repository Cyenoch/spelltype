/**
 * Result persistence: a failed write is never reported as saved, and the unsettled match survives a
 * process restart so the retry still records the match exactly once.
 *
 * The fault is injected into the isolated local D1 file (owned by the harness, never by a public
 * test endpoint) by renaming the `results` table, which is the one failure a player must never see
 * reported as success.
 */
import { expect } from '@playwright/test';
import { test } from '../support/test';
import { INITIAL_HEALTH } from '../../shared/protocol';
import { openD1, querySql, runSql } from '../support/d1';
import { fixture, restartInstance, runtime } from '../support/runtime';
import {
  battleMatchId,
  endReason,
  finalRows,
  playUntilFinished,
  saveStatus,
  waitForCombat,
} from '../support/combat';
import { rowFor, selfIdentity } from '../support/api';
import { gotoApp } from '../support/app';
import { startMatch, twoPlayerRoom } from '../support/lobby';
import { historyRows, openProfile } from '../support/profile';

test.beforeEach(async () => {
  await fixture().reset();
});

test('保存失败不谎称已同步，重启后重试仍然只计一场', async ({ browser }) => {
  test.setTimeout(700_000);
  const room = await twoPlayerRoom(browser, { theme: '持久化契约', difficulty: 'hard' });
  const host = room.host;
  const hostIdentity = await selfIdentity(host.context);
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(room.guest.page)]);
  const liveMatchId = await battleMatchId(host.page);

  // Damage the sink before the match can settle, so the first settlement attempt really fails.
  const db = openD1(runtime().persistDir);
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
    if (await db.tableExists('results_e2e_backup'))
      await runSql(db, 'ALTER TABLE results_e2e_backup RENAME TO results');
  }
  expect(await db.tableExists('results')).toBe(true);

  // The unsettled match is held by the room, so a process restart must not lose it: the room comes
  // back, retries the same write and still records exactly one row.
  await restartInstance();
  await gotoApp(host.page, `/?room=${room.roomId}`);
  await expect.poll(() => saveStatus(host.page), { timeout: 180_000 }).toBe('saved');

  const settledRows = await querySql<{
    damage_dealt: number;
    hp_remaining: number;
    spells_cast: number;
  }>(
    db,
    'SELECT damage_dealt, hp_remaining, spells_cast FROM results WHERE match_id = ? AND user_id = ?',
    [liveMatchId, hostIdentity.userId],
  );
  expect(settledRows).toHaveLength(1);
  expect(settledRows[0].damage_dealt).toBe(INITIAL_HEALTH);
  expect(settledRows[0].hp_remaining).toBe(INITIAL_HEALTH);
  expect(settledRows[0].spells_cast).toBeGreaterThan(0);

  // The stored row is the board the player saw, and it is stored once: no duplicate write survives
  // the restart.
  const rows = await finalRows(host.page);
  const hostRow = rowFor(rows, hostIdentity)!;
  expect(settledRows[0].damage_dealt).toBe(hostRow.damage);
  expect(settledRows[0].hp_remaining).toBe(hostRow.hp);
  await openProfile(host.page);
  const history = await historyRows(host.page);
  expect(history.filter((row) => row.matchId === liveMatchId)).toHaveLength(1);
  expect(history.find((row) => row.matchId === liveMatchId)!.damage).toBe(hostRow.damage);

  await host.context.close();
  await room.guest.context.close();
});
