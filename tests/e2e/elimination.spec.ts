/**
 * 共享威力契约下的淘汰判定权威：单次完成的法术威力在其他所有存活玩家之间平均分配，
 * 因此伤害是集体承受的结果，而非顺时针的单挑 ——
 * 未行动的席位一同失血，已出局的席位无法再造成伤害，且排名遵循结算顺序（幸存者第一，较晚出局者高于较早出局者）。
 *
 * 拒绝判定通过差分对照予以证明 —— 存活玩家的施法在片刻后被正常接受 ——
 * 从而确保该校验源于席位已出局，而非因为数据帧格式错误。
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

  // 席位准确对应三名真实参赛者，按槽位排序，无填充占位席位。
  const seats = await seatOrder(attacker.page);
  expect(seats).toHaveLength(3);
  expect([...seats].sort()).toEqual(identities.map((identity) => identity.userId).sort());

  const book = acceptedGeneration(await fixture().state()).generation.texts;
  const practice = book[0];
  const liveMatchId = await battleMatchId(attacker.page);

  // 集体结算：二号玩家的首次施法同时伤害其他两个存活席位 —— 各承受法术威力的一半 ——
  // 而施法者自身保持满血。旧的顺时针规则本会让其中一人毫发无损。
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

  // 受害者比二号玩家落后一次受击，因此攻击者后续的持续施法（均摊命中每个存活席位）
  // 会在比赛继续进行的过程中率先击倒受害者。
  expect(await defeatSeat(attacker.page, victimId)).toBeGreaterThan(0);
  expect(await battlePhase(attacker.page)).toBe('playing');
  expect(await seatIsOut(attacker.page, victimId)).toBe(true);
  expect(await seatHealth(attacker.page, victimId)).toEqual({ hp: 0, maxHp: INITIAL_HEALTH });
  expect((await seatHealth(attacker.page, helperId)).hp).toBeGreaterThan(0);
  expect((await seatHealth(attacker.page, attackerIdentity.userId)).hp).toBeGreaterThan(0);

  // 已被击败玩家的自身视图退出战斗，输入框被锁定。
  await expect(third.page.getByTestId('eliminated-notice')).toHaveAttribute(
    'data-state',
    'eliminated',
  );
  await expect(typingInput(third.page)).not.toBeEditable();

  // 已淘汰玩家的施法数据包，与房间此前本会接受的数据包完全一致（相同比赛、相同索引、相同文本）。
  // 此时该数据包必须被拒绝。
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

  // 差分对照：存活的二号玩家真实的施法完成在片刻后被接受，
  // 并切实命中唯一剩余的对手。
  await completeSpell(second.page);
  await expect
    .poll(async () => (await seatHealth(attacker.page, attackerIdentity.userId)).hp, {
      timeout: 30_000,
    })
    .toBe(survivorHpBefore - completionDamage(book[1]));

  // 最后一名对手倒下：比赛因击杀淘汰而结算，幸存者排第一，在倒下者中，
  // 较晚倒下的排名更高（排序规则本身已在单元测试中覆盖）。
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
