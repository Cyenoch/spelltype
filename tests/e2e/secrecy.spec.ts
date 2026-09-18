/**
 * Secrecy boundary of a live match: both players get the same spell and the same single deadline,
 * a player only ever receives the spell their own cursor has reached, and no opponent draft — and no
 * future spell of the shared book — is ever sent to a client.
 *
 * The socket capture is the privacy evidence: it is the literal wire, both directions, so a leak
 * cannot hide behind the rendering layer.
 */
import { expect } from '@playwright/test';
import { test } from '../support/test';
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
  selfSpellIndex,
  spellText,
  typeText,
  waitForCombat,
} from '../support/combat';
import { selfIdentity } from '../support/api';
import { settle } from '../support/app';
import { startMatch, twoPlayerRoom } from '../support/lobby';
import { receivedFrames, receivedText, sentMessages } from '../support/wire';

test.beforeEach(async () => {
  await fixture().reset();
});

test('两名玩家看到相同咒文与相同截止时间，未来咒文与对手草稿都不下发', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await twoPlayerRoom(browser, {
    theme: '等价契约',
    sockets: true,
  });
  const host = room.host;
  const guest = room.guest;
  const hostIdentity = await selfIdentity(host.context);
  const hostSockets = room.hostSockets!;
  const guestSockets = room.guestSockets!;

  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guest.page)]);

  const book = acceptedGeneration(await fixture().state()).generation.texts;
  expect(new Set(book).size).toBe(book.length);

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
  await expect
    .poll(() => opponentProgress(guest.page, hostIdentity.userId), { timeout: 20_000 })
    .toBeGreaterThan(0);
  const confirmedPercent = await opponentProgress(guest.page, hostIdentity.userId);
  await insertIntoField(host.page, draftMarker);
  await expect
    .poll(() => opponentProgress(guest.page, hostIdentity.userId), { timeout: 10_000 })
    .toBe(confirmedPercent);
  expect(receivedText(guestSockets)).not.toContain(draftMarker);

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

  // A player only ever receives the spell their own cursor has reached: the guest has completed
  // nothing, so no later book spell appears on their socket.
  const guestReceived = receivedText(guestSockets);
  expect(guestReceived).toContain(book[0]);
  for (const text of book.slice(1)) expect(guestReceived).not.toContain(text);
  // Pre-match snapshots carry timing only, never a target text.
  const guestFrames = receivedFrames(guestSockets);
  for (const frame of guestFrames) {
    if (frame.message?.type !== 'state') continue;
    const phase = frame.message.room.phase;
    if (phase !== 'lobby' && phase !== 'generating') continue;
    for (const text of book) expect(frame.payload).not.toContain(text);
  }
  // The capture really carried authoritative state from this room, so the checks above are not
  // vacuous.
  expect(
    guestFrames.some(
      (frame) => frame.message?.type === 'state' && frame.message.room.id === room.roomId,
    ),
  ).toBe(true);

  // The deadline is one field that never extends: real time passing does not refresh it.
  await settle(1500);
  expect(await deadline(host.page)).toBe(sharedDeadline);
  expect(await deadline(guest.page)).toBe(sharedDeadline);
  expect(await selfSpellIndex(host.page)).toBe(0);

  await host.context.close();
  await guest.context.close();
});
