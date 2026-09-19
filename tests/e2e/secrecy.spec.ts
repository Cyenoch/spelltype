/**
 * 进行中比赛的保密边界：两名玩家获取相同的法术与相同的单一截止时间，
 * 玩家仅会接收到自身游标所到达的法术，绝不会向客户端下发对手的草稿，
 * 也绝不下发共享法术书未来的法术。
 *
 * socket 捕获记录是隐私性的直接证据：它记录了双向的真实链路数据，任何泄露都无法隐藏在渲染层之后。
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

  // 双方目标文本一致，共享同一个绝对截止时间。
  expect(await spellText(host.page)).toBe(book[0]);
  expect(await spellText(guest.page)).toBe(book[0]);
  expect(await battlePhase(host.page)).toBe('playing');
  expect(await battlePhase(guest.page)).toBe('playing');
  const sharedDeadline = await deadline(host.page);
  expect(await deadline(guest.page)).toBe(sharedDeadline);
  expect(sharedDeadline).toBeGreaterThan(Date.now());

  // 已接受的进度会传播；错误的草稿既不推进本玩家的进度，也不会发送给对手。
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

  // 已接受的输入切实按契约格式发送：本场对决 ID 以及该玩家自身的法术游标。无需携带回合字段。
  const inputFrames = sentMessages(hostSockets).filter((frame) => frame.type === 'input');
  expect(inputFrames.length).toBeGreaterThan(0);
  const liveMatchId = await battleMatchId(host.page);
  expect(liveMatchId.length).toBeGreaterThan(0);
  expect(inputFrames.every((frame) => frame.matchId === liveMatchId)).toBe(true);
  expect(inputFrames.every((frame) => frame.spellIndex === 0)).toBe(true);

  // 删除全部错误草稿后，输入框恰好保留已接受的前缀。
  await backspace(host.page, draftMarker.length);
  expect(await inputValue(host.page)).toBe(book[0].slice(0, 4));

  // 公开快照仅包含该玩家自身的法术和草稿。
  const hostView = await roomSnapshot(host.context, room.roomId);
  expect(hostView.spell?.text).toBe(book[0]);
  expect(hostView.selfInput).toBe(book[0].slice(0, 4));
  for (const text of book.slice(1)) expect(JSON.stringify(hostView)).not.toContain(text);
  const guestView = await roomSnapshot(guest.context, room.roomId);
  expect(guestView.spell?.text).toBe(book[0]);
  expect(guestView.selfInput).not.toBe(hostView.selfInput);
  expect(await selfSpellIndex(guest.page)).toBe(0);

  // 玩家仅接收其自身游标已到达的法术：访客尚未完成任何法术，因此其 socket 上绝不会出现后续法术。
  const guestReceived = receivedText(guestSockets);
  expect(guestReceived).toContain(book[0]);
  for (const text of book.slice(1)) expect(guestReceived).not.toContain(text);
  // 比赛开始前的快照仅包含计时信息，绝不包含目标文本。
  const guestFrames = receivedFrames(guestSockets);
  for (const frame of guestFrames) {
    if (frame.message?.type !== 'state') continue;
    const phase = frame.message.room.phase;
    if (phase !== 'lobby' && phase !== 'generating') continue;
    for (const text of book) expect(frame.payload).not.toContain(text);
  }
  // 捕获记录确实承载了来自该房间的权威状态，确保上述断言切实有效。
  expect(
    guestFrames.some(
      (frame) => frame.message?.type === 'state' && frame.message.room.id === room.roomId,
    ),
  ).toBe(true);

  // 截止时间是绝不顺延的单一字段：真实时间的流逝不会刷新它。
  await settle(1500);
  expect(await deadline(host.page)).toBe(sharedDeadline);
  expect(await deadline(guest.page)).toBe(sharedDeadline);
  expect(await selfSpellIndex(host.page)).toBe(0);

  await host.context.close();
  await guest.context.close();
});
