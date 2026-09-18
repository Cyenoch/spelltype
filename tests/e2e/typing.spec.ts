/**
 * Typing semantics under the combat contract, driven through the real field: what counts as an
 * attempt, how deletions and selection replacement behave, that paste is refused, that the last
 * character is what completes a spell, that a replayed completion can never deal a second hit, and
 * that an active IME composition is never judged, never sent and never pollutes accuracy.
 *
 * The accounting itself (attempts/errors/progress) is unit-tested through `diffSnapshot`; what is
 * only observable here is the client + room round trip.
 */
import { expect } from '@playwright/test';
import { test } from '../support/test';
import { INITIAL_HEALTH } from '../../shared/protocol';
import { acceptedGeneration, fixture } from '../support/runtime';
import {
  backspace,
  battleMatchId,
  castState,
  completionDamage,
  inputValue,
  insertIntoField,
  roomSnapshot,
  selfSpellsCast,
  snapshotPlayer,
  spellText,
  typeText,
  waitForCombat,
} from '../support/combat';
import { accuracyPercent, selfIdentity } from '../support/api';
import { settle } from '../support/app';
import { startMatch, twoPlayerRoom } from '../support/lobby';
import { sendRawMessages, sentMessages } from '../support/wire';

declare global {
  interface Window {
    /** Composition-event counters installed by the IME scenario and read back after the run. */
    __composition?: { start: number; end: number };
  }
}

test.beforeEach(async () => {
  await fixture().reset();
});

test('错误、删除、选区替换、粘贴与重复提交都按规则处理', async ({ browser }) => {
  test.setTimeout(400_000);
  const room = await twoPlayerRoom(browser, { theme: '输入契约', difficulty: 'easy' });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  const text = acceptedGeneration(await fixture().state()).generation.texts[0];
  expect(await spellText(host)).toBe(text);

  // A wrong character stalls the accepted prefix; deleting it restores the prefix and leaves the
  // rejected text in the field until it is removed.
  await typeText(host, text.slice(0, 4));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress,
    )
    .toBe(4);
  await insertIntoField(host, '错错');
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress,
    )
    .toBe(4);
  expect(await inputValue(host)).toBe(`${text.slice(0, 4)}错错`);
  await backspace(host, 2);
  expect(await inputValue(host)).toBe(text.slice(0, 4));

  // Selection replacement, deletion and retyping are ordinary edits.
  await typeText(host, text.slice(4, 7));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress,
    )
    .toBe(7);
  await host.keyboard.press('Shift+ArrowLeft');
  await host.keyboard.press('Shift+ArrowLeft');
  await insertIntoField(host, text.slice(5, 7));
  expect(await inputValue(host)).toBe(text.slice(0, 7));
  await backspace(host, 2);
  await insertIntoField(host, text.slice(5, 7));
  expect(await inputValue(host)).toBe(text.slice(0, 7));

  // The last character is what completes the spell: a prefix never advances the cursor and never
  // reports a confirmed completion.
  await typeText(host, text.slice(7, -1));
  await expect.poll(() => inputValue(host)).toBe(text.slice(0, -1));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress,
    )
    .toBe(text.length - 1);
  expect(await castState(host)).not.toBe('done');
  const guestHpBefore = (await roomSnapshot(room.host.context, room.roomId)).players.find(
    (player) => player.id === guestIdentity.userId,
  )!.hp;
  expect(guestHpBefore).toBe(INITIAL_HEALTH);

  // Paste is refused through the real clipboard path and through a paste event, without touching
  // the accepted prefix.
  await room.host.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await host.evaluate((value) => navigator.clipboard.writeText(value), text);
  await host.getByTestId('typing-input').click();
  await host.keyboard.press('ControlOrMeta+V');
  expect(await inputValue(host)).toBe(text.slice(0, -1));
  await expect(host.getByTestId('paste-notice')).not.toBeEmpty();
  await host
    .getByTestId('typing-input')
    .evaluate<void, string, HTMLTextAreaElement>((input, value) => {
      const data = new DataTransfer();
      data.setData('text/plain', value);
      input.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, '整段粘贴的非法咒文');
  expect(await inputValue(host)).toBe(text.slice(0, -1));

  // The final character completes the spell: the opponent really loses one completion's health.
  await insertIntoField(host, text.slice(-1));
  await expect
    .poll(
      async () =>
        (await roomSnapshot(room.host.context, room.roomId)).players.find(
          (player) => player.id === guestIdentity.userId,
        )!.hp,
    )
    .toBe(guestHpBefore - completionDamage(text));
  expect(await selfSpellsCast(host)).toBe(1);

  // Replaying the completion the room already accepted — twice, over a fresh socket — must never
  // deal a second hit or move any counter.
  const settled = await roomSnapshot(room.host.context, room.roomId);
  const liveMatchId = await battleMatchId(host);
  const hostBefore = snapshotPlayer(settled, hostIdentity);
  const guestHpAfterFirst = snapshotPlayer(settled, guestIdentity).hp;

  await sendRawMessages(host, room.roomId, [
    { type: 'input', matchId: liveMatchId, spellIndex: 0, text },
    { type: 'input', matchId: liveMatchId, spellIndex: 0, text },
    { type: 'input', matchId: '000000000000000000000000', spellIndex: 0, text },
  ]);
  await settle(2000);

  const after = await roomSnapshot(room.host.context, room.roomId);
  expect(snapshotPlayer(after, guestIdentity).hp).toBe(guestHpAfterFirst);
  expect(snapshotPlayer(after, hostIdentity).spellsCast).toBe(hostBefore.spellsCast);
  expect(snapshotPlayer(after, hostIdentity).damageDealt).toBe(hostBefore.damageDealt);
  expect(after.events).toHaveLength(settled.events.length);

  await room.host.context.close();
  await room.guest.context.close();
});

test('组合输入期间不判错、不推进、不下发，提交后才计入成绩', async ({ browser }) => {
  test.setTimeout(400_000);
  const room = await twoPlayerRoom(browser, {
    theme: '输入法契约',
    difficulty: 'easy',
    sockets: true,
  });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const sockets = room.hostSockets!;
  const frameText = (): string =>
    sentMessages(sockets)
      .filter((message) => message.type === 'input')
      .map((message) => message.text ?? '')
      .join('\n');
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);
  const text = await spellText(host);

  const acceptedProgress = async (): Promise<number> =>
    snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress;

  await host.bringToFront();
  await host.getByTestId('typing-input').evaluate<void, void, HTMLTextAreaElement>((field) => {
    const counters = { start: 0, end: 0 };
    window.__composition = counters;
    field.addEventListener('compositionstart', () => {
      counters.start += 1;
    });
    field.addEventListener('compositionend', () => {
      counters.end += 1;
    });
  });

  const cdp = await room.host.context.newCDPSession(host);
  await host.getByTestId('typing-input').click();

  // Composing pinyin must not be judged, must not advance the accepted prefix and must not be sent.
  await cdp.send('Input.imeSetComposition', {
    text: 'zhouwen',
    selectionStart: 7,
    selectionEnd: 7,
  });
  await expect.poll(() => host.getByTestId('typing-input').inputValue()).toContain('zhouwen');
  expect(await acceptedProgress()).toBe(0);
  expect(frameText()).not.toContain('zhouwen');

  // Provisional text that happens to match the target prefix is still provisional.
  await cdp.send('Input.imeSetComposition', {
    text: text.slice(0, 3),
    selectionStart: 3,
    selectionEnd: 3,
  });
  await expect
    .poll(() => host.getByTestId('typing-input').inputValue())
    .toContain(text.slice(0, 3));
  expect(await acceptedProgress()).toBe(0);

  // Cancelling that composition leaves nothing behind.
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await expect.poll(() => host.getByTestId('typing-input').inputValue()).toBe('');
  expect(await acceptedProgress()).toBe(0);
  expect(frameText()).not.toContain(text.slice(0, 3));

  // Commit the first characters of the real spell: now they count, locally and on the server.
  await cdp.send('Input.insertText', { text: text.slice(0, 3) });
  await expect.poll(() => host.getByTestId('typing-input').inputValue()).toBe(text.slice(0, 3));
  await expect.poll(acceptedProgress, { timeout: 20_000 }).toBe(3);
  expect(frameText()).toContain(text.slice(0, 3));

  // A cancelled composition is never judged as a mistake: accuracy is still perfect.
  await cdp.send('Input.imeSetComposition', {
    text: 'ceshicuowu',
    selectionStart: 10,
    selectionEnd: 10,
  });
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await expect.poll(() => host.getByTestId('typing-input').inputValue()).toBe(text.slice(0, 3));
  expect(await acceptedProgress()).toBe(3);
  expect(frameText()).not.toContain('ceshicuowu');
  const me = snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity);
  expect(me.accuracy).not.toBeNull();
  expect(accuracyPercent(me.accuracy!)).toBe(100);

  const composition = await host.evaluate(() => window.__composition);
  expect(composition?.start).toBeGreaterThan(0);
  expect(composition?.end).toBeGreaterThan(0);

  // Ordinary editing continues after composition and finishes the spell.
  await insertIntoField(host, text.slice(3, 5));
  await backspace(host, 1);
  await insertIntoField(host, text.slice(4));
  await expect.poll(() => selfSpellsCast(host)).toBe(1);
  await expect.poll(() => inputValue(host)).toBe('');

  await room.host.context.close();
  await room.guest.context.close();
});
