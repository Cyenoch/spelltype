/**
 * Spec 5 — fairness and secrecy: every participant gets the same spell and the same single
 * deadline, a player only ever receives the spell their own cursor has reached, and no opponent
 * draft is ever leaked.
 */
import { expect, test } from '../support/test';
import { INITIAL_HEALTH } from '../../shared/protocol';
import { acceptedGeneration, fixture } from '../support/runtime';
import {
  backspace,
  battleMatchId,
  battlePhase,
  deadline,
  inputValue,
  insertIntoField,
  opponentProgress,
  roomSnapshot,
  seatHealth,
  selfSpellIndex,
  spellText,
  typeText,
  waitForCombat,
} from '../support/combat';
import {
  capturedText,
  receivedFrames,
  receivedText,
  selfIdentity,
  sentMessages,
  settle,
  startMatch,
  testId,
  twoPlayerRoom,
} from '../support/ui';

test.beforeEach(async () => {
  await fixture().reset();
  await fixture().scenario({ mode: 'success' });
});

test('两名玩家看到相同咒文与相同截止时间，未来咒文与对手草稿都不下发', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await twoPlayerRoom(browser, { theme: '等价契约', difficulty: 'easy', sockets: true });
  const host = room.host;
  const guest = room.guest;
  const hostIdentity = await selfIdentity(host.context);
  const guestIdentity = await selfIdentity(guest.context);
  const hostSockets = room.hostSockets!;
  const guestSockets = room.guestSockets!;

  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guest.page)]);

  const { request, generation } = acceptedGeneration(await fixture().state());
  const book = generation.texts;
  // The model really was asked for one book (the room's requirement) and honoured the length band
  // of the difficulty the room declared; the spells are distinct and none contains another, so a
  // whole-text leak check is sound.
  expect(request.difficulty).toBe('easy');
  expect(request.askedCount).toBe(24);
  expect(request.returnedCount).toBe(24);
  expect(request.distinctTexts).toBe(true);
  expect(new Set(book).size).toBe(24);
  for (const text of book) {
    const length = [...text].length;
    expect(length).toBeGreaterThanOrEqual(request.lengthRange[0]);
    expect(length).toBeLessThanOrEqual(request.lengthRange[1]);
    expect(book.filter((candidate) => candidate !== text).some((candidate) => candidate.includes(text))).toBe(false);
  }

  // Identical target text on both sides and one shared, absolute deadline.
  expect(await spellText(host.page)).toBe(book[0]);
  expect(await spellText(guest.page)).toBe(book[0]);
  expect(await battlePhase(host.page)).toBe('playing');
  expect(await battlePhase(guest.page)).toBe('playing');
  const sharedDeadline = await deadline(host.page);
  expect(await deadline(guest.page)).toBe(sharedDeadline);
  expect(sharedDeadline).toBeGreaterThan(Date.now());

  // Accepted progress propagates; a wrong draft neither moves this player's progress nor reaches
  // the opponent.
  const draftMarker = '错错错错错错';
  await typeText(host.page, book[0].slice(0, 4));
  await expect.poll(() => opponentProgress(guest.page, hostIdentity.userId), { timeout: 20_000 }).toBeGreaterThan(0);
  const confirmedPercent = await opponentProgress(guest.page, hostIdentity.userId);
  await insertIntoField(host.page, draftMarker);
  await expect(testId(host.page, 'input-status')).toBeVisible();
  await expect.poll(() => opponentProgress(guest.page, hostIdentity.userId), { timeout: 10_000 }).toBe(confirmedPercent);
  expect(capturedText(guestSockets)).not.toContain(draftMarker);

  // The accepted input really travels as the documented frame: this match's id and this player's
  // own spell cursor. There is no round field to carry.
  const inputFrames = sentMessages(hostSockets).filter((frame) => frame.type === 'input');
  expect(inputFrames.length).toBeGreaterThan(0);
  const liveMatchId = await battleMatchId(host.page);
  expect(liveMatchId.length).toBeGreaterThan(0);
  expect(inputFrames.every((frame) => frame.matchId === liveMatchId)).toBe(true);
  expect(inputFrames.every((frame) => frame.spellIndex === 0)).toBe(true);

  // Deleting the whole wrong draft leaves exactly the accepted prefix behind.
  await backspace(host.page, draftMarker.length);
  expect(await inputValue(host.page)).toBe(book[0].slice(0, 4));

  // The public snapshot carries this player's own spell and own draft only.
  const hostView = await roomSnapshot(host.context, room.roomId);
  expect(hostView.spell?.text).toBe(book[0]);
  expect(hostView.selfInput).toBe(book[0].slice(0, 4));
  for (const text of book.slice(1)) expect(JSON.stringify(hostView)).not.toContain(text);
  const guestView = await roomSnapshot(guest.context, room.roomId);
  expect(guestView.spell?.text).toBe(book[0]);
  expect(guestView.selfInput).not.toBe(hostView.selfInput);
  expect(await selfSpellIndex(guest.page)).toBe(0);
  expect(guestView.players.find((player) => player.id === hostIdentity.userId)!.progress).toBe(4);
  // Nobody has completed a spell yet, so no damage has been dealt or taken.
  expect(await seatHealth(guest.page, guestIdentity.userId)).toEqual({ hp: INITIAL_HEALTH, maxHp: INITIAL_HEALTH });
  expect(await seatHealth(guest.page, hostIdentity.userId)).toEqual({ hp: INITIAL_HEALTH, maxHp: INITIAL_HEALTH });

  // A player only ever receives the spell their own cursor has reached: the guest has completed
  // nothing, so no later book spell appears on their socket.
  const guestReceived = receivedText(guestSockets);
  expect(guestReceived).toContain(book[0]);
  for (const text of book.slice(1)) expect(guestReceived).not.toContain(text);
  // Pre-match snapshots carry timing only, never a target text.
  for (const frame of receivedFrames(guestSockets)) {
    const phase = frame.room?.phase;
    if (phase !== 'lobby' && phase !== 'generating') continue;
    for (const text of book) expect(frame.payload).not.toContain(text);
  }
  // The capture really carried authoritative state in both directions, so the checks above are not
  // vacuous.
  expect(receivedFrames(guestSockets).some((frame) => frame.message.type === 'state' && frame.room?.id === room.roomId)).toBe(true);
  expect(sentMessages(hostSockets).some((frame) => frame.type === 'input')).toBe(true);

  // The deadline is one field that never extends: real time passing does not refresh it.
  await settle(1500);
  expect(await deadline(host.page)).toBe(sharedDeadline);
  expect(await deadline(guest.page)).toBe(sharedDeadline);
  expect(await selfSpellIndex(host.page)).toBe(0);

  await host.context.close();
  await guest.context.close();
});
