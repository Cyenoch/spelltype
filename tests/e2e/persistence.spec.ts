/**
 * Result persistence: the terminal transition and the result rows commit together or not at all,
 * and the accepted cast commits earlier still — its intent is durable across failed settlements
 * and restarts, so the recovery never needs a resend.
 *
 * A completion commits the cast intent (the room's one open 100ms volley) and the spell cursor in
 * one transaction; damage, elimination, the result rows, the terminal phase and the intent's
 * removal share one later transaction. The fault is injected through the owning server's Drizzle
 * instance (harness-owned, never a public test endpoint) by renaming the `results` table: the
 * settlement attempt cannot write its rows and rolls back whole — HP and terminal never move
 * while the accepted intent stays. The broken state is then driven through a real server
 * restart, and once the sink heals the room's own retry finishes the match without any further
 * input, storing exactly one row per player.
 */
import { expect, type BrowserContext } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { combatVolleys, rooms } from '../../server/db';
import type { RoomSnapshot } from '../../shared/protocol';
import { test } from '../support/test';
import {
  breakResultsSink,
  resultRowsFor,
  resultsSinkIsBroken,
  restoreResultsSink,
  testDb,
} from '../support/db';
import { harness } from '../support/harness';
import { fixture } from '../support/runtime';
import {
  battleMatchId,
  battlePhase,
  completionDamage,
  completeSpell,
  deadline,
  endReason,
  finalRows,
  inputValue,
  saveStatus,
  selfSpellIndex,
  selfSpellsCast,
  snapshotPlayer,
  spellText,
  waitForCombat,
  waitForMatchEnd,
} from '../support/combat';
import { gameJson, rowFor, selfIdentity, type Identity } from '../support/api';
import { gotoApp } from '../support/app';
import { startMatch, twoPlayerRoom } from '../support/lobby';
import { historyRows, openProfile } from '../support/profile';

type VolleyRow = typeof combatVolleys.$inferSelect;

test.beforeEach(async () => {
  await fixture().reset();
});

/** Snapshot reader local to this spec: the authoritative room view of one participant. */
async function roomSnapshotOf(context: BrowserContext, roomId: string): Promise<RoomSnapshot> {
  const response = await gameJson<RoomSnapshot>(context, `/rooms/${roomId}`);
  expect(response.status).toBe(200);
  return response.body;
}

/** The room's one durable volley row — the accepted cast intent between cast and batch. */
async function durableVolley(roomId: string): Promise<VolleyRow | null> {
  const rows = await testDb().select().from(combatVolleys).where(eq(combatVolleys.room_id, roomId));
  return rows[0] ?? null;
}

/** The room row's persisted next wake-up — the durable clock a failed settle re-arms. */
async function nextAlarmAt(roomId: string): Promise<number | null> {
  const rows = await testDb()
    .select({ at: rooms.next_alarm_at })
    .from(rooms)
    .where(eq(rooms.id, roomId));
  return rows[0]?.at ?? null;
}

test('结算与战绩同事务：写入失败整体回滚不结算，重启后重试仍然只计一场', async ({ browser }) => {
  test.setTimeout(700_000);
  const room = await twoPlayerRoom(browser, { theme: '持久化契约' });
  const host = room.host;
  const guest = room.guest;
  const hostIdentity = await selfIdentity(host.context);
  const guestIdentity: Identity = await selfIdentity(guest.context);
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guest.page)]);
  const liveMatchId = await battleMatchId(host.page);

  // Whittle the guest down with committed volleys. Every cast's power is read from the spell the
  // host is actually on (4 damage per code point), and each volley is observed on the guest's
  // authoritative HP before the next cast, so the loop never races its own pending damage. It
  // stops the moment the NEXT accepted cast is guaranteed lethal: 0 < hp ≤ power of the open
  // spell, so the killing input is the only blow left.
  const guestHp = async () =>
    snapshotPlayer(await roomSnapshotOf(host.context, room.roomId), guestIdentity).hp;
  let hpBefore = await guestHp();
  let spells = 0;
  let lethalPower = 0;
  for (;;) {
    lethalPower = completionDamage(await spellText(host.page));
    if (hpBefore <= lethalPower) break;
    expect(spells).toBeLessThan(40);
    await completeSpell(host.page);
    spells += 1;
    const expected = hpBefore - lethalPower;
    await expect.poll(() => guestHp(), { timeout: 20_000 }).toBe(expected);
    hpBefore = expected;
  }
  expect(hpBefore).toBeGreaterThan(0);
  expect(lethalPower).toBeGreaterThan(0);
  expect(hpBefore).toBeLessThanOrEqual(lethalPower);

  // Damage the sink before the match can settle, so the settlement attempt really fails.
  expect(await resultsSinkIsBroken()).toBe(false);
  await breakResultsSink();

  const killingSpell = await spellText(host.page);
  const killingIndex = await selfSpellIndex(host.page);

  try {
    // Exactly one eligible lethal input: the completion waits out the spell's own input gate, so
    // it is accepted. Acceptance and cursor commit durably ahead of any damage — the killing
    // volley's settlement then fails whole, and nothing about it lands.
    await completeSpell(host.page);
    const acceptedSpells = spells + 1;
    expect(await selfSpellsCast(host.page)).toBe(acceptedSpells);
    expect(await selfSpellIndex(host.page)).toBe(killingIndex + 1);
    expect(await battlePhase(host.page)).toBe('playing');

    // The accepted intent is durable and names exactly this killing cast; the durable wake-up
    // moves past the batch boundary only once a failed settle re-armed the retry clock, and HP,
    // phase and persistence show that nothing of the volley committed.
    await expect.poll(async () => durableVolley(room.roomId), { timeout: 20_000 }).not.toBeNull();
    const volley = (await durableVolley(room.roomId))!;
    expect(volley.match_id).toBe(liveMatchId);
    expect(volley.casts).toHaveLength(1);
    expect(volley.casts[0].attackerId).toBe(hostIdentity.userId);
    expect(volley.casts[0].spellIndex).toBe(killingIndex);
    expect(volley.casts[0].power).toBe(lethalPower);
    await expect
      .poll(() => nextAlarmAt(room.roomId), { timeout: 20_000 })
      .toBeGreaterThan(volley.ends_at);
    expect(await guestHp()).toBe(hpBefore);
    expect((await durableVolley(room.roomId))!.casts).toEqual(volley.casts);
    expect((await roomSnapshotOf(host.context, room.roomId)).persistence).toBe('idle');

    // The unsettled match is held by the room, so a server restart must not lose it: the match
    // comes back live with the same deadline and HP, the durable intent unchanged, and the
    // client already past the accepted cast — there is nothing left to resubmit.
    const combatDeadline = await deadline(host.page);
    await harness().restartServer();
    await gotoApp(host.page, `/?room=${room.roomId}`);
    await waitForCombat(host.page);
    expect(await battleMatchId(host.page)).toBe(liveMatchId);
    expect(await deadline(host.page)).toBe(combatDeadline);
    expect(await guestHp()).toBe(hpBefore);
    expect(await selfSpellIndex(host.page)).toBe(killingIndex + 1);
    expect(await selfSpellsCast(host.page)).toBe(acceptedSpells);
    expect(await spellText(host.page)).not.toBe(killingSpell);
    await expect.poll(() => inputValue(host.page), { timeout: 20_000 }).toBe('');
    const restored = (await durableVolley(room.roomId))!;
    expect(restored.match_id).toBe(liveMatchId);
    expect(restored.ends_at).toBe(volley.ends_at);
    expect(restored.casts).toEqual(volley.casts);
  } finally {
    // The injected fault must never outlive this test, wherever it failed above.
    if (await resultsSinkIsBroken()) await restoreResultsSink();
  }
  expect(await resultsSinkIsBroken()).toBe(false);

  // With the sink healed the room's own retry lands the durable volley — no further input — and
  // the terminal phase and every row commit together. Nobody marks a settled match as unsynced
  // afterwards, and no second killing cast was ever accepted.
  await waitForMatchEnd(host.page);
  expect(await endReason(host.page)).toBe('elimination');
  await expect.poll(() => saveStatus(host.page), { timeout: 60_000 }).toBe('saved');
  expect(await selfSpellsCast(host.page)).toBe(spells + 1);

  // The stored row is the board the player saw, and it is stored once: the rolled-back attempts
  // left nothing behind, and the settled match records exactly one row per player.
  const rows = await finalRows(host.page);
  const hostRow = rowFor(rows, hostIdentity)!;
  const allRows = await resultRowsFor(liveMatchId);
  expect(allRows).toHaveLength(2);
  const settledHostRows = allRows.filter((row) => row.user_id === hostIdentity.userId);
  const settledGuestRows = allRows.filter((row) => row.user_id === guestIdentity.userId);
  expect(settledHostRows).toHaveLength(1);
  expect(settledGuestRows).toHaveLength(1);
  // The host is the survivor: their stored health is the health the board showed, while the one
  // durable killing volley is the guest's zero — accepted exactly once, landed exactly once.
  expect(settledHostRows[0].hp_remaining).toBe(hostRow.hp);
  expect(settledHostRows[0].hp_remaining).toBeGreaterThan(0);
  expect(settledGuestRows[0].hp_remaining).toBe(0);
  expect(settledHostRows[0].damage_dealt).toBe(hostRow.damage);
  expect(settledHostRows[0].spells_cast).toBe(hostRow.spells);
  expect(settledHostRows[0].spells_cast).toBe(spells + 1);
  expect(settledHostRows[0].spells_cast).toBeGreaterThan(0);
  expect(settledGuestRows[0].spells_cast).toBe(0);

  await openProfile(host.page);
  const history = await historyRows(host.page);
  expect(history.filter((row) => row.matchId === liveMatchId)).toHaveLength(1);
  expect(history.find((row) => row.matchId === liveMatchId)!.damage).toBe(hostRow.damage);

  await host.context.close();
  await guest.context.close();
});
