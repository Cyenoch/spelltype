/**
 * Spec 8 — the timeout path, which is the only way a match can end without an elimination.
 *
 * The deadline is server-authoritative and there is no timing override anywhere in the product, so
 * this spec really waits out the full 240 seconds of combat while sampling the clock to prove it
 * never extends. It is the one spec that spends that much wall-clock time.
 */
import { expect, test } from '../support/test';
import { INITIAL_HEALTH, MATCH_DURATION_MS } from '../../shared/protocol';
import { acceptedGeneration, fixture } from '../support/runtime';
import {
  battlePhase,
  damageSeat,
  deadline,
  endReason,
  finalRows,
  roomSnapshot,
  seatHealth,
  seatIsOut,
  snapshotPlayer,
  startedAt,
  targetSeat,
  waitForCombat,
  waitForMatchEnd,
} from '../support/combat';
import { apiJson, historyRows, openProfile, rowFor, seatedRoom, selfIdentity, settle, startMatch } from '../support/ui';

test.beforeEach(async () => {
  await fixture().reset();
  await fixture().scenario({ mode: 'success' });
});

test('时间耗尽按剩余生命排名，完全并列共享名次且截止时间从不延长', async ({ browser }) => {
  // 240s of real combat plus setup and assertions.
  test.setTimeout(420_000);
  const room = await seatedRoom(browser, 4, { theme: '计时契约', difficulty: 'hard' });
  const sessions = room.sessions;
  const identities = await Promise.all(sessions.map((session) => selfIdentity(session.context)));
  const attacker = sessions[0];
  const attackerIdentity = identities[0];
  await startMatch(attacker.page);
  await Promise.all(sessions.map((session) => waitForCombat(session.page)));

  const { request, generation } = acceptedGeneration(await fixture().state());
  expect(request.difficulty).toBe('hard');
  expect(request.askedCount).toBe(24);
  expect(request.returnedCount).toBe(24);
  expect(request.distinctTexts).toBe(true);
  expect(generation.texts).toHaveLength(24);

  // The combat deadline is derived once from the combat start and is one absolute instant.
  const combatDeadline = await deadline(attacker.page);
  expect(await startedAt(attacker.page)).toBeGreaterThan(0);
  expect(combatDeadline).toBe((await startedAt(attacker.page)) + MATCH_DURATION_MS);
  for (const session of sessions) expect(await deadline(session.page)).toBe(combatDeadline);

  // Automatic targeting: seat 0 attacks the next alive seat clockwise.
  const targetId = await targetSeat(attacker.page).getAttribute('data-user');
  expect(targetId).not.toBeNull();
  expect([...identities].slice(1).some((identity) => identity.userId === targetId)).toBe(true);

  // One player deals a bounded amount of damage; nobody is eliminated, so the clock decides.
  await damageSeat(attacker.page, targetId!, 400);
  const targetSeatAfterHits = await seatHealth(attacker.page, targetId!);
  expect(targetSeatAfterHits.hp).toBeLessThan(INITIAL_HEALTH);
  const dealt = INITIAL_HEALTH - targetSeatAfterHits.hp;
  expect(dealt).toBeGreaterThanOrEqual(400);
  expect(await seatIsOut(attacker.page, targetId!)).toBe(false);
  expect(await battlePhase(attacker.page)).toBe('playing');
  expect(await seatIsOut(attacker.page, attackerIdentity.userId)).toBe(false);

  // Sample the clock across the whole combat phase: every participant keeps reading the same single
  // instant, and the match stays live until that instant arrives.
  let samples = 0;
  let liveOnLastSample = false;
  while (Date.now() < combatDeadline - 1_000) {
    if ((await battlePhase(attacker.page)) === 'finished') break;
    liveOnLastSample = true;
    samples += 1;
    expect(await deadline(attacker.page)).toBe(combatDeadline);
    for (const session of sessions) expect(await deadline(session.page)).toBe(combatDeadline);
    await settle(Math.min(20_000, Math.max(1_000, combatDeadline - Date.now() - 500)));
  }
  expect(samples).toBeGreaterThanOrEqual(8);
  expect(liveOnLastSample, 'nobody was eliminated, so only the clock may settle this match').toBe(true);

  await waitForMatchEnd(attacker.page, 60_000);
  const settledAt = Date.now();
  expect(await endReason(attacker.page)).toBe('timeout');
  // The match could not settle before its own deadline, and the deadline is still the same instant
  // afterwards: the clock was neither shortened nor extended.
  expect(settledAt).toBeGreaterThanOrEqual(combatDeadline);
  expect(settledAt).toBeLessThan(combatDeadline + 60_000);
  expect(await deadline(attacker.page)).toBe(combatDeadline);

  // Ranking: survivors by remaining health descending, and exact ties share a competition rank.
  const rows = await finalRows(attacker.page);
  expect(rows).toHaveLength(4);
  const damagedRow = rowFor(rows, identities.find((identity) => identity.userId === targetId)!)!;
  const idleRows = rows.filter((row) => row.user !== damagedRow.user);
  expect(idleRows).toHaveLength(3);
  // Health descends first, then damage dealt, then confirmed characters. The attacker and the two
  // players who never touched the keyboard all finished at full health, so the attacker's damage
  // separates it from the other two — who are exactly tied on all three keys, share a competition
  // rank, and sit behind the attacker and ahead of the damaged player.
  const attackerRow = rowFor(rows, attackerIdentity)!;
  expect(new Set(idleRows.map((row) => row.rank))).toEqual(new Set([2]));
  for (const row of idleRows) {
    expect(row.hp).toBe(INITIAL_HEALTH);
    expect(row.damage).toBe(0);
    expect(row.eliminated).toBe(false);
  }
  expect(attackerRow.rank).toBe(1);
  expect(attackerRow.damage).toBeGreaterThan(0);
  expect(damagedRow.hp).toBe(INITIAL_HEALTH - dealt);
  // Three players are ranked ahead of the damaged one, so the next distinct rank is 4.
  expect(damagedRow.rank).toBe(4);
  expect(damagedRow.eliminated).toBe(false);
  expect(damagedRow.damage).toBe(0);

  // The attacker's totals: damage dealt to the automatic target, and the characters that produced
  // it, with no elimination at the end.
  expect(attackerRow.damage).toBe(dealt);
  expect(attackerRow.spells).toBeGreaterThan(0);
  expect(attackerRow.hp).toBe(INITIAL_HEALTH);
  expect(attackerRow.cpm).toBeGreaterThan(0);

  // Ranks exist only after the match settled, and the snapshot agrees with the panel.
  const snapshot = await roomSnapshot(attacker.context, room.roomId);
  expect(snapshot.endReason).toBe('timeout');
  expect(snapshot.endedAt).not.toBeNull();
  expect(snapshot.players.every((player) => player.rank !== null)).toBe(true);
  expect(snapshotPlayer(snapshot, attackerIdentity).damageDealt).toBe(dealt);
  expect(snapshot.events.length).toBeGreaterThan(0);
  expect(snapshot.events.every((event) => event.eliminated === false)).toBe(true);

  // The persisted record measures the active combat time, so it must be the full match duration and
  // not the sum of any number of shorter segments.
  await openProfile(attacker.page);
  const history = await historyRows(attacker.page);
  const entry = history.find((row) => row.matchId === snapshot.matchId);
  expect(entry).toBeDefined();
  expect(entry!.rank).toBe(1);
  expect(entry!.damage).toBe(dealt);
  expect(entry!.hp).toBe(INITIAL_HEALTH);
  const persisted = await apiJson<{ history: { match_id: string; duration_ms: number | null; correct_chars: number | null; rank: number; cpm: number }[] }>(
    attacker.context,
    '/api/profile',
  );
  const record = persisted.body.history.find((row) => row.match_id === snapshot.matchId)!;
  expect(record.duration_ms).not.toBeNull();
  expect(record.duration_ms!).toBeGreaterThanOrEqual(MATCH_DURATION_MS - 1_000);
  expect(record.duration_ms!).toBeLessThan(MATCH_DURATION_MS + 15_000);
  expect(record.correct_chars).toBe(snapshotPlayer(snapshot, attackerIdentity).correctChars);
  expect(record.rank).toBe(1);
  expect(record.cpm).toBe(attackerRow.cpm);

  for (const session of sessions) await session.context.close();
});
