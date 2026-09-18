/**
 * Elimination authority under the shared-power contract: one completion's power splits evenly
 * across every other living player, so damage is a group outcome rather than a clockwise duel —
 * the idle seats bleed together, the seat that fell can no longer deal damage, and the ranks
 * follow the settlement order (survivor first, later fall above earlier fall).
 *
 * The refusal is proven against a differential control — a living player's completion is accepted
 * moments later — so the check is about the eliminated seat rather than about a malformed frame.
 */
import { expect } from '@playwright/test';
import { test } from '../support/test';
import { INITIAL_HEALTH } from '../../shared/protocol';
import { acceptedGeneration, fixture } from '../support/runtime';
import {
  battleMatchId,
  battlePhase,
  completeSpell,
  completionDamage,
  defeatSeat,
  endReason,
  finalRows,
  playUntilFinished,
  roomSnapshot,
  seatHealth,
  seatIsOut,
  seatOrder,
  typingInput,
  waitForCombat,
} from '../support/combat';
import { rowFor, selfIdentity } from '../support/api';
import { settle } from '../support/app';
import { seatedRoom, startMatch } from '../support/lobby';
import { sendRawMessages } from '../support/wire';

test.beforeEach(async () => {
  await fixture().reset();
});

test('伤害均摊到所有存活对手，出局者再也无法造成伤害，名次按结算顺序', async ({ browser }) => {
  test.setTimeout(600_000);
  const room = await seatedRoom(browser, 3, { theme: '出局契约' });
  const [first, second, third] = room.sessions;
  const attacker = first;
  const identities = await Promise.all(
    room.sessions.map((session) => selfIdentity(session.context)),
  );
  const [attackerIdentity, helperIdentity, victimIdentity] = identities;
  const victimId = victimIdentity.userId;
  const helperId = helperIdentity.userId;
  await startMatch(attacker.page);
  await Promise.all(room.sessions.map((session) => waitForCombat(session.page)));

  // Seats are exactly the three real participants, ordered by slot, with no filler seats.
  const seats = await seatOrder(attacker.page);
  expect(seats).toHaveLength(3);
  expect([...seats].sort()).toEqual(identities.map((identity) => identity.userId).sort());

  const book = acceptedGeneration(await fixture().state()).generation.texts;
  const practice = book[0];
  const liveMatchId = await battleMatchId(attacker.page);

  // Group outcome: the helper's first completion damages BOTH other living seats — half of the
  // spell's power each — while the caster keeps full health. The old clockwise rule would have
  // left one of them untouched.
  const half = completionDamage(practice) / 2;
  await completeSpell(second.page);
  await expect
    .poll(async () => (await seatHealth(attacker.page, attackerIdentity.userId)).hp, {
      timeout: 30_000,
    })
    .toBe(INITIAL_HEALTH - half);
  await expect
    .poll(async () => (await seatHealth(attacker.page, victimId)).hp, { timeout: 30_000 })
    .toBe(INITIAL_HEALTH - half);
  expect((await seatHealth(attacker.page, helperId)).hp).toBe(INITIAL_HEALTH);

  // The victim sits one hit behind the helper, so the attacker's continuing casts — which hit
  // every living seat equally — fell the victim first while the match goes on.
  expect(await defeatSeat(attacker.page, victimId)).toBeGreaterThan(0);
  expect(await battlePhase(attacker.page)).toBe('playing');
  expect(await seatIsOut(attacker.page, victimId)).toBe(true);
  expect(await seatHealth(attacker.page, victimId)).toEqual({ hp: 0, maxHp: INITIAL_HEALTH });
  expect((await seatHealth(attacker.page, helperId)).hp).toBeGreaterThan(0);
  expect((await seatHealth(attacker.page, attackerIdentity.userId)).hp).toBeGreaterThan(0);

  // The defeated player's own view is out of the fight, with the field locked.
  await expect(third.page.getByTestId('eliminated-notice')).toHaveAttribute(
    'data-state',
    'eliminated',
  );
  await expect(typingInput(third.page)).not.toBeEditable();

  // A defeated player's completion is exactly the packet the room would have accepted from them
  // one hit earlier (same match, same index, same text). It must now be refused.
  const survivorHpBefore = (await seatHealth(attacker.page, attackerIdentity.userId)).hp;
  const helperHpBefore = (await seatHealth(attacker.page, helperId)).hp;
  await sendRawMessages(third.page, room.roomId, [
    { type: 'input', matchId: liveMatchId, spellIndex: 0, draftEpoch: 0, text: practice },
  ]);
  await settle(2000);
  expect((await seatHealth(attacker.page, attackerIdentity.userId)).hp).toBe(survivorHpBefore);
  expect((await seatHealth(attacker.page, helperId)).hp).toBe(helperHpBefore);
  const afterDeadSend = await roomSnapshot(attacker.context, room.roomId);
  expect(afterDeadSend.events.every((event) => event.attackerId !== victimId)).toBe(true);

  // Differential control: the living helper's real completion is accepted moments later and
  // lands on the only remaining opponent.
  await completeSpell(second.page);
  await expect
    .poll(async () => (await seatHealth(attacker.page, attackerIdentity.userId)).hp, {
      timeout: 30_000,
    })
    .toBe(survivorHpBefore - completionDamage(book[1]));

  // The last opponent falls: the match settles by elimination, survivor first, and of the fallen
  // the one who fell later ranks higher (the ordering rules themselves are unit-tested).
  await playUntilFinished(attacker.page);
  expect(await endReason(attacker.page)).toBe('elimination');
  const rows = await finalRows(attacker.page);
  expect(rows).toHaveLength(3);
  const winner = rowFor(rows, attackerIdentity)!;
  expect(winner.rank).toBe(1);
  expect(winner.eliminated).toBe(false);
  const helperRow = rowFor(rows, helperIdentity)!;
  const victimRow = rowFor(rows, victimIdentity)!;
  expect(helperRow.rank).toBe(2);
  expect(victimRow.rank).toBe(3);
  for (const row of [helperRow, victimRow]) {
    expect(row.eliminated).toBe(true);
    expect(row.hp).toBe(0);
  }

  await first.context.close();
  await second.context.close();
  await third.context.close();
});
