/**
 * Spec 7 — input-method composition.
 *
 * The composition events come from the browser's real IME pipeline
 * (`Input.imeSetComposition` / `Input.insertText` over CDP), not from synthetic
 * `dispatchEvent` calls, so the page receives genuine `compositionstart`/`compositionend`
 * events. A real desktop IME on the tester's machine is still required for final
 * sign-off; that limitation is documented in the suite notes.
 *
 * Under the combat contract the point is unchanged: provisional text is never judged, never
 * advances the accepted prefix, never travels on the wire and never pollutes accuracy.
 */
import { expect, test } from '../support/test';
import type { RoomSnapshot } from '../../shared/protocol';
import { fixture } from '../support/runtime';
import {
  backspace,
  completeSpell,
  finalRows,
  insertIntoField,
  opponentProgress,
  playUntilFinished,
  roomSnapshot,
  selfProgress,
  snapshotPlayer,
  spellText,
  waitForCombat,
} from '../support/combat';
import {
  accuracyPercent,
  apiJson,
  rowFor,
  selfIdentity,
  sentMessages,
  startMatch,
  testId,
  twoPlayerRoom,
} from '../support/ui';

test.beforeEach(async () => {
  await fixture().reset();
  await fixture().scenario({ mode: 'success' });
});

test('组合输入期间不判错不推进不下发，提交后才计入成绩', async ({ browser }) => {
  test.setTimeout(400_000);
  const room = await twoPlayerRoom(browser, { theme: '输入法契约', difficulty: 'easy', sockets: true });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  const sockets = room.hostSockets!;
  const frameText = (): string => sockets.frames.map((frame) => frame.payload).join('\n');
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);
  const text = await spellText(host);
  expect(text.length).toBeGreaterThan(8);

  const acceptedProgress = async (): Promise<number> =>
    snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress;

  await host.bringToFront();
  await host.evaluate(() => {
    const field = document.getElementById('typing-input') as HTMLTextAreaElement;
    const counters = { start: 0, end: 0 };
    (window as unknown as { __composition: typeof counters }).__composition = counters;
    field.addEventListener('compositionstart', () => {
      counters.start += 1;
    });
    field.addEventListener('compositionend', () => {
      counters.end += 1;
    });
  });

  const cdp = await room.host.context.newCDPSession(host);
  await testId(host, 'typing-input').click();

  // Composing pinyin must not be judged, must not advance the accepted prefix and must not be sent.
  await cdp.send('Input.imeSetComposition', { text: 'zhouwen', selectionStart: 7, selectionEnd: 7 });
  await expect.poll(() => testId(host, 'typing-input').inputValue()).toContain('zhouwen');
  expect(await acceptedProgress()).toBe(0);
  expect(await opponentProgress(guest, hostIdentity.userId)).toBe(0);
  expect(frameText()).not.toContain('zhouwen');

  // Candidate switching keeps the composition open.
  await cdp.send('Input.imeSetComposition', { text: 'zhouwenjue', selectionStart: 10, selectionEnd: 10 });
  await expect.poll(() => testId(host, 'typing-input').inputValue()).toContain('zhouwenjue');
  expect(await acceptedProgress()).toBe(0);
  expect(await opponentProgress(guest, hostIdentity.userId)).toBe(0);

  // Provisional text that happens to match the target prefix is still provisional: it must not
  // advance local progress, server progress, or show an error.
  await cdp.send('Input.imeSetComposition', { text: text.slice(0, 3), selectionStart: 3, selectionEnd: 3 });
  await expect.poll(() => testId(host, 'typing-input').inputValue()).toContain(text.slice(0, 3));
  expect((await selfProgress(host)).percent).toBe(0);
  expect(await acceptedProgress()).toBe(0);
  expect(await opponentProgress(guest, hostIdentity.userId)).toBe(0);

  // Cancelling that composition leaves nothing behind.
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await expect.poll(() => testId(host, 'typing-input').inputValue()).toBe('');
  expect(await acceptedProgress()).toBe(0);
  expect(await opponentProgress(guest, hostIdentity.userId)).toBe(0);

  // Commit the first characters of the real spell: now they count, locally and on the server.
  await cdp.send('Input.insertText', { text: text.slice(0, 3) });
  await expect.poll(() => testId(host, 'typing-input').inputValue()).toBe(text.slice(0, 3));
  await expect.poll(() => acceptedProgress(), { timeout: 20_000 }).toBe(3);
  await expect
    .poll(() => sentMessages(sockets).some((frame) => frame.type === 'input' && (frame.text ?? '').includes(text.slice(0, 3))), { timeout: 20_000 })
    .toBe(true);
  expect(frameText()).not.toContain('zhouwenjue');

  // Cancelling a composition leaves no residue and no false mistake: accuracy is still untouched,
  // which is the honest signal that a cancelled composition was never judged.
  await cdp.send('Input.imeSetComposition', { text: 'ceshicuowu', selectionStart: 10, selectionEnd: 10 });
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await expect.poll(() => testId(host, 'typing-input').inputValue()).toBe(text.slice(0, 3));
  expect(await acceptedProgress()).toBe(3);
  expect(frameText()).not.toContain('ceshicuowu');
  const during = await apiJson<RoomSnapshot>(room.host.context, `/api/rooms/${room.roomId}`);
  expect(during.status).toBe(200);
  const me = snapshotPlayer(during.body, hostIdentity);
  expect(me.accuracy).not.toBeNull();
  expect(accuracyPercent(me.accuracy!)).toBe(100);

  const compositionCounters = await host.evaluate(() => (window as unknown as { __composition: { start: number; end: number } }).__composition);
  expect(compositionCounters.start).toBeGreaterThan(0);
  expect(compositionCounters.end).toBeGreaterThan(0);

  // Baseline: the capture is live for this socket, so the "nothing was sent" checks above are
  // meaningful rather than vacuous.
  expect(sentMessages(sockets).filter((frame) => frame.type === 'input').length).toBeGreaterThan(0);

  // Ordinary editing continues after composition and finishes the spell.
  await insertIntoField(host, text.slice(3, 5));
  await backspace(host, 1);
  await insertIntoField(host, text.slice(4));
  expect(await completeSpell(host)).toBe(text);

  // The host plays the match out; a clean run must end with a perfect accuracy figure, proving the
  // composition episodes were never counted as mistakes.
  await playUntilFinished(host);
  const finalHost = rowFor(await finalRows(host), hostIdentity);
  expect(finalHost).toBeDefined();
  expect(finalHost!.accuracy).toMatch(/100/);
  expect(finalHost!.cpm).toBeGreaterThan(0);
  const finalGuest = rowFor(await finalRows(guest), guestIdentity);
  expect(finalGuest).toBeDefined();
  expect(finalGuest!.accuracy).not.toMatch(/\d/);

  await room.host.context.close();
  await room.guest.context.close();
});
