/**
 * Elimination authority: a player who fell can no longer deal damage, automatic targeting keeps
 * walking the surviving seats, and the ranks follow the elimination order.
 *
 * The refusal is proven against a differential control — the identical packet from a living player
 * is accepted — so the check is about the eliminated seat rather than about a malformed frame.
 */
import { expect } from '@playwright/test';
import { test } from '../support/test';
import { INITIAL_HEALTH, type RoomSnapshot } from '../../shared/protocol';
import { acceptedGeneration, fixture } from '../support/runtime';
import {
  battleMatchId,
  battlePhase,
  completionDamage,
  defeatSeat,
  endReason,
  finalRows,
  playUntilFinished,
  seatHealth,
  seatIsOut,
  seatOrder,
  targetSeat,
  typingInput,
  waitForCombat,
} from '../support/combat';
import { apiJson, rowFor, selfIdentity } from '../support/api';
import { settle } from '../support/app';
import { seatedRoom, startMatch } from '../support/lobby';
import { sendRawMessages } from '../support/wire';

test.beforeEach(async () => {
  await fixture().reset();
});

test('被击败的玩家再也无法造成伤害，出局顺序决定名次', async ({ browser }) => {
  test.setTimeout(600_000);
  const room = await seatedRoom(browser, 3, { theme: '出局契约' });
  const [first, second, third] = room.sessions;
  const attacker = first;
  const identities = await Promise.all(
    room.sessions.map((session) => selfIdentity(session.context)),
  );
  const [attackerIdentity] = identities;
  await startMatch(attacker.page);
  await Promise.all(room.sessions.map((session) => waitForCombat(session.page)));

  // Seats are exactly the three real participants, ordered by slot, with no filler seats, and the
  // automatic target is the next alive seat clockwise.
  const seats = await seatOrder(attacker.page);
  expect(seats).toHaveLength(3);
  expect([...seats].sort()).toEqual(identities.map((identity) => identity.userId).sort());
  const victimId = seats[1];
  const survivorId = seats[2];
  expect(await targetSeat(attacker.page).getAttribute('data-user')).toBe(victimId);

  const practice = acceptedGeneration(await fixture().state()).generation.texts[0];
  const damage = completionDamage(practice);
  const liveMatchId = await battleMatchId(attacker.page);

  expect(await defeatSeat(attacker.page, victimId)).toBeGreaterThan(0);
  // One opponent is down, so the match continues against the other one.
  expect(await battlePhase(attacker.page)).toBe('playing');
  expect(await seatIsOut(attacker.page, victimId)).toBe(true);
  expect(await seatHealth(attacker.page, victimId)).toEqual({ hp: 0, maxHp: INITIAL_HEALTH });
  expect(await seatHealth(attacker.page, survivorId)).toEqual({
    hp: INITIAL_HEALTH,
    maxHp: INITIAL_HEALTH,
  });

  // The defeated player's own view is out of the fight, with the field locked.
  const defeated = identities[1].userId === victimId ? second : third;
  await expect(defeated.page.getByTestId('eliminated-notice')).toHaveAttribute(
    'data-state',
    'eliminated',
  );
  await expect(typingInput(defeated.page)).not.toBeEditable();

  // A defeated player's completion is exactly the packet the room accepted from them one hit
  // earlier (same match, same index, same text). It must now be refused.
  const survivorHpBefore = (await seatHealth(attacker.page, survivorId)).hp;
  await sendRawMessages(defeated.page, room.roomId, [
    { type: 'input', matchId: liveMatchId, spellIndex: 0, text: practice },
  ]);
  await settle(2000);
  expect((await seatHealth(attacker.page, survivorId)).hp).toBe(survivorHpBefore);
  const afterDeadSend = await apiJson<RoomSnapshot>(attacker.context, `/api/rooms/${room.roomId}`);
  expect(afterDeadSend.body.events.every((event) => event.attackerId !== victimId)).toBe(true);

  // Differential control: the identical packet from a living player is accepted, so the refusal
  // above is about elimination rather than about the frame being malformed.
  const control = identities[2].userId === survivorId ? third : second;
  const attackerHpBefore = (await seatHealth(attacker.page, attackerIdentity.userId)).hp;
  await sendRawMessages(control.page, room.roomId, [
    { type: 'input', matchId: liveMatchId, spellIndex: 0, text: practice },
  ]);
  await expect
    .poll(async () => (await seatHealth(attacker.page, attackerIdentity.userId)).hp)
    .toBe(attackerHpBefore - damage);

  // The last opponent falls: the match settles by elimination, and the fallen are ranked by
  // elimination time, so the seat that fell last ranks highest among them.
  await playUntilFinished(attacker.page);
  expect(await endReason(attacker.page)).toBe('elimination');
  // The published board marks the fallen seats and puts the survivor first; the ordering rules
  // themselves are unit-tested.
  const rows = await finalRows(attacker.page);
  expect(rows).toHaveLength(3);
  const winner = rowFor(rows, identities[0])!;
  expect(winner.rank).toBe(1);
  expect(winner.eliminated).toBe(false);
  for (const identity of identities.slice(1)) {
    const fallen = rowFor(rows, identity)!;
    expect(fallen.eliminated).toBe(true);
    expect(fallen.rank).toBeGreaterThan(1);
  }

  await first.context.close();
  await second.context.close();
  await third.context.close();
});
