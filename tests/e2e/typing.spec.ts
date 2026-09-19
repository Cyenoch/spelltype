/**
 * 战斗契约下的打字语义，通过真实输入框驱动：
 * 什么算作一次尝试、删除与选区替换的行为、粘贴会被拒绝、
 * 完成一道咒文的是最后一个字符、重放的完成绝不可能造成第二次命中，
 * 以及正在进行的 IME 拼写绝不被判定、绝不被发送，也绝不污染准确率。
 *
 * 记账本身（尝试/错误/进度）通过 `diffSnapshot` 做单元测试；
 * 此处只能观测到的是客户端与房间之间的往返。
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
  waitForInputGate,
} from '../support/combat';
import { accuracyPercent, selfIdentity } from '../support/api';
import { settle } from '../support/app';
import { startMatch, twoPlayerRoom } from '../support/lobby';
import { sendRawMessages, sentMessages } from '../support/wire';

declare global {
  interface Window {
    /** 由 IME 场景安装、并在运行结束后读回的拼写事件计数器。 */
    __composition?: { start: number; end: number };
  }
}

test.beforeEach(async () => {
  await fixture().reset();
});

test('错误、删除、选区替换、粘贴与重复提交都按规则处理', async ({ browser }) => {
  test.setTimeout(400_000);
  const room = await twoPlayerRoom(browser, { theme: '输入契约' });
  const host = room.host.page;
  const guest = room.guest.page;
  const hostIdentity = await selfIdentity(room.host.context);
  const guestIdentity = await selfIdentity(room.guest.context);
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(guest)]);

  const text = acceptedGeneration(await fixture().state()).generation.texts[0];
  expect(await spellText(host)).toBe(text);

  // 一个错误字符会卡住已接受前缀；删除它会恢复该前缀，
  // 而被拒绝的文本会一直留在输入框中，直到被移除。
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

  // 选区替换、删除与重新输入都属于普通编辑。
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

  // 完成这道咒文的是最后一个字符：仅有前缀绝不会推进游标，
  // 也绝不会报告一次已确认的完成。
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

  // 粘贴会通过真实的剪贴板路径与粘贴事件被拒绝，且不影响已接受前缀。
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

  // 全角等价字符会在完成之前被自动纠正，且不应为此记一次错误。
  expect(text).toMatch(/[!~]$/);
  // 只有当该观察者自身的门槛开启后，完成才是合法的：
  // 等待服务端的 notBefore，而不是用真实击键时间与它抢跑。
  await waitForInputGate(host);
  const lastPunctuation = String.fromCharCode(text.charCodeAt(text.length - 1) + 0xfee0);
  const accuracyBefore = snapshotPlayer(
    await roomSnapshot(room.host.context, room.roomId),
    hostIdentity,
  ).accuracy;
  await insertIntoField(host, lastPunctuation);
  await expect
    .poll(
      async () =>
        (await roomSnapshot(room.host.context, room.roomId)).players.find(
          (player) => player.id === guestIdentity.userId,
        )!.hp,
    )
    .toBe(guestHpBefore - completionDamage(text));
  expect(await selfSpellsCast(host)).toBe(1);
  expect(
    snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).accuracy,
  ).toBeGreaterThan(accuracyBefore!);

  // 重放房间已经接受的那次完成 —— 在一条新 Socket 上重放两次 ——
  // 绝不能造成第二次命中，也不能移动任何计数器。
  const settled = await roomSnapshot(room.host.context, room.roomId);
  const liveMatchId = await battleMatchId(host);
  const hostBefore = snapshotPlayer(settled, hostIdentity);
  const guestHpAfterFirst = snapshotPlayer(settled, guestIdentity).hp;

  await sendRawMessages(host, room.roomId, [
    { type: 'input', matchId: liveMatchId, spellIndex: 0, draftEpoch: 0, text },
    { type: 'input', matchId: liveMatchId, spellIndex: 0, draftEpoch: 0, text },
    { type: 'input', matchId: '000000000000000000000000', spellIndex: 0, draftEpoch: 0, text },
  ]);
  await settle(2000);

  const after = await roomSnapshot(room.host.context, room.roomId);
  expect(snapshotPlayer(after, guestIdentity).hp).toBe(guestHpAfterFirst);
  expect(snapshotPlayer(after, hostIdentity).spellsCast).toBe(hostBefore.spellsCast);
  expect(snapshotPlayer(after, hostIdentity).damageDealt).toBe(hostBefore.damageDealt);
  expect(after.events).toHaveLength(settled.events.length);

  // 即便客户端发送未纠正的帧，房间也会施加同样的纠正。
  // 被接受的完成随其批次窗口落地，因此轮询目标是房主的生命值 ——
  // 在窗口结束之前，只有咒文计数器会先行推进。
  await sendRawMessages(guest, room.roomId, [
    {
      type: 'input',
      matchId: liveMatchId,
      spellIndex: 0,
      draftEpoch: 0,
      text: text.slice(0, -1) + lastPunctuation,
    },
  ]);
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(room.host.context, room.roomId), hostIdentity).hp,
    )
    .toBe(INITIAL_HEALTH - completionDamage(text));
  const corrected = await roomSnapshot(room.host.context, room.roomId);
  expect(snapshotPlayer(corrected, guestIdentity).spellsCast).toBe(1);
  expect(snapshotPlayer(corrected, guestIdentity).accuracy).toBe(1);

  await room.host.context.close();
  await room.guest.context.close();
});

test('组合输入期间不判错、不推进、不下发，提交后才计入成绩', async ({ browser }) => {
  test.setTimeout(400_000);
  const room = await twoPlayerRoom(browser, {
    theme: '输入法契约',
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

  // 拼写拼音绝不被判定、绝不推进已接受前缀，也绝不被发送。
  await cdp.send('Input.imeSetComposition', {
    text: 'zhouwen',
    selectionStart: 7,
    selectionEnd: 7,
  });
  await expect.poll(() => host.getByTestId('typing-input').inputValue()).toContain('zhouwen');
  expect(await acceptedProgress()).toBe(0);
  expect(frameText()).not.toContain('zhouwen');

  // 临时文本即便恰好匹配目标前缀，仍然是临时的。
  await cdp.send('Input.imeSetComposition', {
    text: text.slice(0, 3),
    selectionStart: 3,
    selectionEnd: 3,
  });
  await expect
    .poll(() => host.getByTestId('typing-input').inputValue())
    .toContain(text.slice(0, 3));
  expect(await acceptedProgress()).toBe(0);

  // 取消该次拼写不会留下任何痕迹。
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
  await expect.poll(() => host.getByTestId('typing-input').inputValue()).toBe('');
  expect(await acceptedProgress()).toBe(0);
  expect(frameText()).not.toContain(text.slice(0, 3));

  // 提交真实咒文的前几个字符：现在它们会被计入，本地与服务端都是如此。
  await cdp.send('Input.insertText', { text: text.slice(0, 3) });
  await expect.poll(() => host.getByTestId('typing-input').inputValue()).toBe(text.slice(0, 3));
  await expect.poll(acceptedProgress, { timeout: 20_000 }).toBe(3);
  expect(frameText()).toContain(text.slice(0, 3));

  // 被取消的拼写绝不被判定为错误：准确率依然是完美的。
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

  // 拼写结束后普通编辑继续，并最终完成这道咒文。
  // 最后几个字符只有在该观察者自身的门槛开启后才能输入。
  await waitForInputGate(host);
  await insertIntoField(host, text.slice(3, 5));
  await backspace(host, 1);
  await insertIntoField(host, text.slice(4));
  await expect.poll(() => selfSpellsCast(host)).toBe(1);
  await expect.poll(() => inputValue(host)).toBe('');

  await room.host.context.close();
  await room.guest.context.close();
});
