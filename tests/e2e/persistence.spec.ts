/**
 * 战绩持久化：终局状态转换与结果行要么同时提交，要么完全不提交，
 * 且被接受的施法意图更早提交 —— 其意图在结算失败与服务重启中保持持久化，
 * 因此恢复时绝无需重新发送。
 *
 * 一次施法完成会在单次事务中提交施法意图（房间当前开放的 100ms 齐射排期行）和法术游标；
 * 随后的另一次事务则统一处理伤害、淘汰、结果行、终局状态以及意图的移除。
 * 故障通过宿主服务端的 Drizzle 实例（脚手架持有，绝非公开测试端点）重命名 `results` 表来注入：
 * 结算尝试无法写入行并发生整体回滚 —— 只要被接受的意图仍在，生命值与终局状态绝不变更。
 * 该损坏状态随后经历真实的服务端重启，一旦存储层恢复，房间自有的重试机制无需任何额外输入即可完成对局，
 * 且每位玩家恰好持久化存储一行记录。
 */
import { expect, type BrowserContext } from '@playwright/test';
import { eq } from 'drizzle-orm';
import { combatVolleys, rooms } from '../../server/db';
import type { RoomSnapshot } from '../../shared/protocol';
import { test } from '../support/test';
import {
  breakResultsSink,
  resultRowsFor,
  resultsSinkIsBroken,
  restoreResultsSink,
  testDb,
} from '../support/db';
import { harness } from '../support/harness';
import { fixture } from '../support/runtime';
import {
  battleMatchId,
  battlePhase,
  completionDamage,
  completeSpell,
  deadline,
  endReason,
  finalRows,
  inputValue,
  saveStatus,
  selfSpellIndex,
  selfSpellsCast,
  snapshotPlayer,
  spellText,
  waitForCombat,
  waitForMatchEnd,
} from '../support/combat';
import { gameJson, rowFor, selfIdentity, type Identity } from '../support/api';
import { gotoApp } from '../support/app';
import { startMatch, twoPlayerRoom } from '../support/lobby';
import { historyRows, openProfile } from '../support/profile';

type VolleyRow = typeof combatVolleys.$inferSelect;

test.beforeEach(async () => {
  await fixture().reset();
});

/** 本测试文件专用的快照读取器：单个参赛者视角的房间权威视图。 */
async function roomSnapshotOf(context: BrowserContext, roomId: string): Promise<RoomSnapshot> {
  const response = await gameJson<RoomSnapshot>(context, `/rooms/${roomId}`);
  expect(response.status).toBe(200);
  return response.body;
}

/** 房间唯一的持久化齐射排期行 —— 施法与批次落地之间已接受的施法意图。 */
async function durableVolley(roomId: string): Promise<VolleyRow | null> {
  const rows = await testDb().select().from(combatVolleys).where(eq(combatVolleys.room_id, roomId));
  return rows[0] ?? null;
}

/** 房间行持久化的下次唤醒时刻 —— 结算失败重新加锁重试的持久化闹钟。 */
async function nextAlarmAt(roomId: string): Promise<number | null> {
  const rows = await testDb()
    .select({ at: rooms.next_alarm_at })
    .from(rooms)
    .where(eq(rooms.id, roomId));
  return rows[0]?.at ?? null;
}

test('结算与战绩同事务：写入失败整体回滚不结算，重启后重试仍然只计一场', async ({ browser }) => {
  test.setTimeout(700_000);
  const room = await twoPlayerRoom(browser, { theme: '持久化契约' });
  const host = room.host;
  const guest = room.guest;
  const hostIdentity = await selfIdentity(host.context);
  const guestIdentity: Identity = await selfIdentity(guest.context);
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guest.page)]);
  const liveMatchId = await battleMatchId(host.page);

  // 通过已提交的齐射逐步削减访客血量。每次施法的威力均根据房主实际所处的法术读取（每码点 4 伤害），
  // 且每次齐射在下一次施法前均通过访客的权威 HP 予以确认，因此循环绝不会与自身未决的伤害产生竞态。
  // 当下一次被接受的施法确定足以致死时停下：0 < hp ≤ 当前法术威力，从而确保击杀输入是最后唯一的一击。
  const guestHp = async () =>
    snapshotPlayer(await roomSnapshotOf(host.context, room.roomId), guestIdentity).hp;
  let hpBefore = await guestHp();
  let spells = 0;
  let lethalPower = 0;
  for (;;) {
    lethalPower = completionDamage(await spellText(host.page));
    if (hpBefore <= lethalPower) break;
    expect(spells).toBeLessThan(40);
    await completeSpell(host.page);
    spells += 1;
    const expected = hpBefore - lethalPower;
    await expect.poll(() => guestHp(), { timeout: 20_000 }).toBe(expected);
    hpBefore = expected;
  }
  expect(hpBefore).toBeGreaterThan(0);
  expect(lethalPower).toBeGreaterThan(0);
  expect(hpBefore).toBeLessThanOrEqual(lethalPower);

  // 在比赛可能结算前破坏结果表，使得结算尝试切实失败。
  expect(await resultsSinkIsBroken()).toBe(false);
  await breakResultsSink();

  const killingSpell = await spellText(host.page);
  const killingIndex = await selfSpellIndex(host.page);

  try {
    // 恰好一次合规的致死输入：施法完成等待法术自有的输入门禁放行，因此被正常接受。
    // 接受与游标推进持久化提交于任何伤害之前 —— 随后致死齐射的结算整体失败，没有任何效果落地。
    await completeSpell(host.page);
    const acceptedSpells = spells + 1;
    expect(await selfSpellsCast(host.page)).toBe(acceptedSpells);
    expect(await selfSpellIndex(host.page)).toBe(killingIndex + 1);
    expect(await battlePhase(host.page)).toBe('playing');

    // 被接受的意图保持持久化且明确指向该致死施法；持久化唤醒时间在结算失败重新设定重试闹钟后
    // 移至批次边界之后，生命值、阶段和 persistence 均表明齐射没有任何部分发生提交。
    await expect.poll(async () => durableVolley(room.roomId), { timeout: 20_000 }).not.toBeNull();
    const volley = (await durableVolley(room.roomId))!;
    expect(volley.match_id).toBe(liveMatchId);
    expect(volley.casts).toHaveLength(1);
    expect(volley.casts[0].attackerId).toBe(hostIdentity.userId);
    expect(volley.casts[0].spellIndex).toBe(killingIndex);
    expect(volley.casts[0].power).toBe(lethalPower);
    await expect
      .poll(() => nextAlarmAt(room.roomId), { timeout: 20_000 })
      .toBeGreaterThan(volley.ends_at);
    expect(await guestHp()).toBe(hpBefore);
    expect((await durableVolley(room.roomId))!.casts).toEqual(volley.casts);
    expect((await roomSnapshotOf(host.context, room.roomId)).persistence).toBe('idle');

    // 未结算的比赛由房间保留，因此服务端重启绝不能丢失它：比赛恢复为活动状态，
    // 拥有相同的截止时刻与生命值，持久化意图未变，客户端已越过已接受的施法 —— 无需重复提交任何内容。
    const combatDeadline = await deadline(host.page);
    await harness().restartServer();
    await gotoApp(host.page, `/?room=${room.roomId}`);
    await waitForCombat(host.page);
    expect(await battleMatchId(host.page)).toBe(liveMatchId);
    expect(await deadline(host.page)).toBe(combatDeadline);
    expect(await guestHp()).toBe(hpBefore);
    expect(await selfSpellIndex(host.page)).toBe(killingIndex + 1);
    expect(await selfSpellsCast(host.page)).toBe(acceptedSpells);
    expect(await spellText(host.page)).not.toBe(killingSpell);
    await expect.poll(() => inputValue(host.page), { timeout: 20_000 }).toBe('');
    const restored = (await durableVolley(room.roomId))!;
    expect(restored.match_id).toBe(liveMatchId);
    expect(restored.ends_at).toBe(volley.ends_at);
    expect(restored.casts).toEqual(volley.casts);
  } finally {
    // 无论上方何处发生失败，注入的故障绝不能遗留到本测试之外。
    if (await resultsSinkIsBroken()) await restoreResultsSink();
  }
  expect(await resultsSinkIsBroken()).toBe(false);

  // 存储层恢复后，房间自有的重试使持久化齐射落地 —— 无需额外输入 ——
  // 且终局阶段与每一行数据同时提交。事后没有任何逻辑将已结算比赛标记为未同步，也绝没有第二次接受致死施法。
  await waitForMatchEnd(host.page);
  expect(await endReason(host.page)).toBe('elimination');
  await expect.poll(() => saveStatus(host.page), { timeout: 60_000 }).toBe('saved');
  expect(await selfSpellsCast(host.page)).toBe(spells + 1);

  // 持久化存储的行即为玩家所看到的结算看板，且仅存储一次：回滚的尝试未留下任何痕迹，
  // 已结算对决为每位玩家恰好记录一行数据。
  const rows = await finalRows(host.page);
  const hostRow = rowFor(rows, hostIdentity)!;
  const allRows = await resultRowsFor(liveMatchId);
  expect(allRows).toHaveLength(2);
  const settledHostRows = allRows.filter((row) => row.user_id === hostIdentity.userId);
  const settledGuestRows = allRows.filter((row) => row.user_id === guestIdentity.userId);
  expect(settledHostRows).toHaveLength(1);
  expect(settledGuestRows).toHaveLength(1);
  // 房主为幸存者：其存储的血量即为结算板上展示的血量，而单次持久化的致死齐射使访客归零 ——
  // 恰好接受一次，恰好落地一次。
  expect(settledHostRows[0].hp_remaining).toBe(hostRow.hp);
  expect(settledHostRows[0].hp_remaining).toBeGreaterThan(0);
  expect(settledGuestRows[0].hp_remaining).toBe(0);
  expect(settledHostRows[0].damage_dealt).toBe(hostRow.damage);
  expect(settledHostRows[0].spells_cast).toBe(hostRow.spells);
  expect(settledHostRows[0].spells_cast).toBe(spells + 1);
  expect(settledHostRows[0].spells_cast).toBeGreaterThan(0);
  expect(settledGuestRows[0].spells_cast).toBe(0);

  await openProfile(host.page);
  const history = await historyRows(host.page);
  expect(history.filter((row) => row.matchId === liveMatchId)).toHaveLength(1);
  expect(history.find((row) => row.matchId === liveMatchId)!.damage).toBe(hostRow.damage);

  await host.context.close();
  await guest.context.close();
});
