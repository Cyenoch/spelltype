/**
 * Spec 6 — typing semantics under the combat contract: what counts as an attempt, how deletions and
 * selection replacement behave, that the last character is what completes a spell, that paste is
 * refused, and that nothing is accepted once the match has settled.
 */
import { expect, test } from '../support/test';
import { DAMAGE_PER_CHARACTER, INITIAL_HEALTH, MATCH_DURATION_MS, type RoomSnapshot } from '../../shared/protocol';
import { acceptedGeneration, fixture } from '../support/runtime';
import {
  backspace,
  battleMatchId,
  battlePhase,
  castState,
  completeSpell,
  completionDamage,
  endReason,
  finalRows,
  inputValue,
  insertIntoField,
  playUntilFinished,
  roomSnapshot,
  selfSpellsCast,
  snapshotPlayer,
  spellText,
  typeText,
  waitForCombat,
} from '../support/combat';
import {
  accuracyPercent,
  apiJson,
  rowFor,
  selfIdentity,
  sendRawMessages,
  settle,
  startMatch,
  testId,
  twoPlayerRoom,
} from '../support/ui';

test.beforeEach(async () => {
  await fixture().reset();
  await fixture().scenario({ mode: 'success' });
});

test('同一浏览器任务内的错误与修正不会丢失统计', async ({ browser }) => {
  test.setTimeout(240_000);
  const room = await twoPlayerRoom(browser, { theme: '快速修正', difficulty: 'easy' });
  const host = room.host.page;
  const hostIdentity = await selfIdentity(room.host.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(room.guest.page)]);
  const text = await spellText(host);

  // A wrong character, its deletion and the correction happen inside a single browser task, i.e.
  // inside one client debounce window. The mistake must still be counted.
  await testId(host, 'typing-input').click();
  await host.evaluate((value) => {
    const field = document.getElementById('typing-input') as HTMLTextAreaElement;
    field.focus();
    document.execCommand('insertText', false, value.slice(0, 4));
    document.execCommand('insertText', false, '错');
    document.execCommand('delete');
    document.execCommand('insertText', false, value.slice(4, 8));
  }, text);

  await expect.poll(() => inputValue(host), { timeout: 20_000 }).toBe(text.slice(0, 8));
  const snapshot = await apiJson<RoomSnapshot>(room.host.context, `/api/rooms/${room.roomId}`);
  expect(snapshot.status).toBe(200);
  const me = snapshotPlayer(snapshot.body, hostIdentity);
  // Eight characters of the current spell are accepted, so the wrong attempt is excluded from the
  // accepted prefix but not from the accuracy figure: 8 of 9 counted characters.
  expect(me.progress).toBe(8);
  expect(me.accuracy).not.toBeNull();
  expect(accuracyPercent(me.accuracy!)).toBeCloseTo(88.9, 0);

  // Finishing the spell keeps the mistake on the record and deals the full damage for it.
  const guestIdentity = await selfIdentity(room.guest.context);
  const guestHpBefore = (await roomSnapshot(room.host.context, room.roomId)).players.find((player) => player.id === guestIdentity.userId)!.hp;
  await completeSpell(host);
  const after = await roomSnapshot(room.host.context, room.roomId);
  expect(snapshotPlayer(after, guestIdentity).hp).toBe(guestHpBefore - completionDamage(text));
  expect(snapshotPlayer(after, hostIdentity).accuracy).not.toBeNull();
  expect(accuracyPercent(snapshotPlayer(after, hostIdentity).accuracy!)).toBeLessThan(100);
  expect(await selfSpellsCast(host)).toBe(1);

  await room.host.context.close();
  await room.guest.context.close();
});

test('错误、删除、选区替换、重复提交与终局后的输入都按规则处理', async ({ browser }) => {
  test.setTimeout(400_000);
  const room = await twoPlayerRoom(browser, { theme: '输入契约', difficulty: 'easy' });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  const { generation } = acceptedGeneration(await fixture().state());
  const book = generation.texts;
  const text = book[0];
  expect(await spellText(host)).toBe(text);

  // A wrong character stalls the accepted prefix; deleting it restores the prefix and leaves the
  // rejected text in the field until it is removed.
  await typeText(host, text.slice(0, 4));
  await expect.poll(async () => snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress).toBe(4);
  await insertIntoField(host, '错错');
  await expect.poll(async () => snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress).toBe(4);
  expect(await inputValue(host)).toBe(`${text.slice(0, 4)}错错`);
  await backspace(host, 2);
  expect(await inputValue(host)).toBe(text.slice(0, 4));

  // Selection replacement, deletion and retyping are ordinary edits.
  await typeText(host, text.slice(4, 7));
  await expect.poll(async () => snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress).toBe(7);
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
  await expect.poll(async () => snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).progress).toBe(text.length - 1);
  expect(await castState(host)).not.toBe('done');
  const guestHpBefore = (await roomSnapshot(room.host.context, room.roomId)).players.find((player) => player.id === guestIdentity.userId)!.hp;

  // Paste is refused through the real clipboard path and through a paste event, without touching
  // the accepted prefix.
  await room.host.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await host.evaluate((value) => navigator.clipboard.writeText(value), text);
  await testId(host, 'typing-input').click();
  await host.keyboard.press('ControlOrMeta+V');
  expect(await inputValue(host)).toBe(text.slice(0, -1));
  await expect(testId(host, 'paste-notice')).not.toBeEmpty();
  await host.evaluate(() => {
    const field = document.getElementById('typing-input') as HTMLTextAreaElement;
    const data = new DataTransfer();
    data.setData('text/plain', '整段粘贴的非法咒文');
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  expect(await inputValue(host)).toBe(text.slice(0, -1));

  // The final character completes the spell and nothing was dealt before it.
  await insertIntoField(host, text.slice(-1));
  await expect.poll(() => inputValue(host)).toBe(text);
  await expect.poll(async () => (await roomSnapshot(room.host.context, room.roomId)).players.find((player) => player.id === guestIdentity.userId)!.hp).toBe(
    guestHpBefore - completionDamage(text),
  );
  expect(await selfSpellsCast(host)).toBe(1);

  // Play the match out, then try to settle it again over raw frames with the finished match's own
  // id, index and text: a finished match accepts nothing.
  await playUntilFinished(host);
  expect(await battlePhase(host)).toBe('finished');
  expect(await endReason(host)).toBe('elimination');
  const settledMatchId = await battleMatchId(host);
  const settled = await apiJson<RoomSnapshot>(room.host.context, `/api/rooms/${room.roomId}`);
  const settledHost = snapshotPlayer(settled.body, hostIdentity);

  const finishedText = generation.texts[settledHost.spellsCast % generation.texts.length];
  await sendRawMessages(host, room.roomId, [
    { type: 'input', matchId: settledMatchId, spellIndex: settledHost.spellIndex, text: finishedText },
    { type: 'input', matchId: settledMatchId, spellIndex: settledHost.spellIndex, text: finishedText },
  ]);
  await settle(2000);

  const after = await apiJson<RoomSnapshot>(room.host.context, `/api/rooms/${room.roomId}`);
  expect(snapshotPlayer(after.body, hostIdentity).spellsCast).toBe(settledHost.spellsCast);
  expect(snapshotPlayer(after.body, hostIdentity).damageDealt).toBe(settledHost.damageDealt);
  expect(after.body.events).toHaveLength(settled.body.events.length);
  expect(snapshotPlayer(after.body, guestIdentity).hp).toBe(snapshotPlayer(settled.body, guestIdentity).hp);

  await room.host.context.close();
  await room.guest.context.close();
});

test('零作答显示为占位符而非满准确率，伤害与字符数按规则聚合', async ({ browser }) => {
  test.setTimeout(400_000);
  const room = await twoPlayerRoom(browser, { theme: '空白契约', difficulty: 'hard' });
  const host = room.host.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(room.guest.page)]);

  // The host plays the whole match; the opponent never touches the keyboard. Every spell of one
  // book has the same length, which makes the character total exactly predictable.
  const book = acceptedGeneration(await fixture().state()).generation.texts;
  const spellLength = [...book[0]].length;
  const cast = await playUntilFinished(host);
  expect(cast).toBeGreaterThan(0);
  expect(await endReason(host)).toBe('elimination');

  const rows = await finalRows(host);
  expect(rows).toHaveLength(2);
  const guestRow = rowFor(rows, guestIdentity)!;
  const hostRow = rowFor(rows, hostIdentity)!;

  // A player who never answered has no accuracy figure at all — a placeholder, not 100%.
  expect(guestRow.accuracy).not.toMatch(/\d/);
  expect(guestRow.accuracy).toMatch(/[—–-]/);
  expect(guestRow.cpm).toBe(0);
  expect(guestRow.damage).toBe(0);
  expect(guestRow.spells).toBe(0);
  expect(guestRow.hp).toBe(0);
  expect(guestRow.eliminated).toBe(true);
  expect(guestRow.rank).toBe(2);

  // The winner's totals are the combat rules aggregated over every completed spell: the target was
  // reduced from full health to zero, so the damage dealt equals the starting health exactly, and
  // the completed characters are exactly that damage divided by the per-character rate (the final
  // blow is bounded by the remaining health, which is what makes the totals land on the health cap).
  expect(hostRow.rank).toBe(1);
  expect(hostRow.eliminated).toBe(false);
  expect(hostRow.damage).toBe(INITIAL_HEALTH);
  expect(hostRow.spells).toBe(cast);
  expect(hostRow.cpm).toBeGreaterThan(0);
  expect(hostRow.accuracy).toMatch(/\d/);
  expect(accuracyPercent(hostRow.accuracy)).toBe(100);

  const me = snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity);
  // Every completed spell contributed its whole text to the confirmed-character count, including the
  // final blow whose damage was bounded by the target's remaining health: the character total is at
  // least the damage divided by the per-character rate, and here it is exactly the number of spells
  // that were completed times the length of every spell in this book.
  expect(me.damageDealt).toBe(INITIAL_HEALTH);
  expect(me.correctChars).toBeGreaterThanOrEqual(INITIAL_HEALTH / DAMAGE_PER_CHARACTER);
  expect(me.correctChars).toBe(hostRow.spells * spellLength);
  // CPM is measured over this player's own active combat time, which ended long before the 240s
  // deadline, so it must be strictly better than the deadline-based bound.
  const deadlineBasedCpm = me.correctChars / (MATCH_DURATION_MS / 60_000);
  expect(me.cpm).toBeGreaterThan(deadlineBasedCpm);
  expect(hostRow.cpm).toBe(me.cpm);

  await room.host.context.close();
  await room.guest.context.close();
});
