/**
 * 断线：对局绝不冻结，重连的玩家能拿回自己的席位、生命值与已接受的草稿，
 * 而进行中的对局 —— 身份、绝对截止时间、每位玩家的进度 —— 能在进程重启后存活。
 * （会话在对局中途失效的场景由 auth 测试覆盖。）
 *
 * 测试环境在相同端口与数据库上重启原生运行时，且不使用任何产品测试钩子，
 * 因此只有已提交的状态能够存活。
 */
import { expect } from '@playwright/test';
import { test } from '../support/test';
import { INITIAL_HEALTH } from '../../shared/protocol';
import { acceptedGeneration, fixture } from '../support/runtime';
import { harness } from '../support/harness';
import {
  battleMatchId,
  battlePhase,
  completeSpell,
  completionDamage,
  deadline,
  inputValue,
  roomSnapshot,
  seatHealth,
  snapshotPlayer,
  spellText,
  timerRemaining,
  typeText,
  waitForCombat,
} from '../support/combat';
import { selfIdentity } from '../support/api';
import { gotoApp, settle } from '../support/app';
import { startMatch, twoPlayerRoom } from '../support/lobby';
import { newContext, signIn } from '../support/session';

test.beforeEach(async () => {
  await fixture().reset();
});

test('对手断线不冻结比赛，重连与进程重启后恢复席位、血量与已接受草稿', async ({ browser }) => {
  test.setTimeout(900_000);
  const room = await twoPlayerRoom(browser, { theme: '断线契约' });
  const host = room.host;
  const guest = room.guest;
  const guestIdentity = await selfIdentity(guest.context);
  const hostIdentity = await selfIdentity(host.context);
  const guestName = guestIdentity.username;
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guest.page)]);

  const book = acceptedGeneration(await fixture().state()).generation.texts;
  const firstSpell = book[0];
  const liveMatchId = await battleMatchId(host.page);
  const combatDeadline = await deadline(host.page);

  // 客方提交一段前缀（房主可以看到），随后完全断开网络。
  await typeText(guest.page, firstSpell.slice(0, 5));
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(host.context, room.roomId), guestIdentity).progress,
      { timeout: 20_000 },
    )
    .toBe(5);
  await guest.context.close();

  // 仍在场的玩家看到的是继续走动、不断递减的时钟，而不是一场冻结的对局。
  const before = await timerRemaining(host.page);
  await settle(2500);
  expect(await timerRemaining(host.page)).toBeLessThan(before - 1000);
  expect(await host.page.getByTestId('arena-seat').count()).toBe(2);
  expect(await battlePhase(host.page)).toBe('playing');

  // 断线的玩家保留其席位、已接受前缀与生命值；只有连接标记发生变化。
  await expect
    .poll(
      async () =>
        snapshotPlayer(await roomSnapshot(host.context, room.roomId), guestIdentity).connected,
      { timeout: 20_000 },
    )
    .toBe(false);
  const during = await roomSnapshot(host.context, room.roomId);
  expect(during.matchId).toBe(liveMatchId);
  expect(snapshotPlayer(during, guestIdentity).progress).toBe(5);
  expect(snapshotPlayer(during, guestIdentity).hp).toBe(INITIAL_HEALTH);

  // 对局在对手缺席时仍继续推进：真实的完成依然会打到缺席的目标身上。
  // 伤害随该次完成的批次窗口一同到达，因此生命值的读取需要轮询。
  await completeSpell(host.page);
  await expect
    .poll(
      async () => snapshotPlayer(await roomSnapshot(host.context, room.roomId), guestIdentity).hp,
      { timeout: 30_000 },
    )
    .toBe(INITIAL_HEALTH - completionDamage(firstSpell));
  const damaged = await roomSnapshot(host.context, room.roomId);
  expect(snapshotPlayer(damaged, hostIdentity).spellsCast).toBe(1);

  // 重连：相同席位、相同对局、相同已接受草稿，且只恢复到该名玩家。
  const firstReconnect = await newContext(browser);
  const firstPage = await firstReconnect.newPage();
  await gotoApp(firstPage, '/');
  await signIn(firstPage, guestName);
  await gotoApp(firstPage, `/?room=${room.roomId}`);
  await waitForCombat(firstPage);
  expect(await battleMatchId(firstPage)).toBe(liveMatchId);
  expect(await deadline(firstPage)).toBe(combatDeadline);
  await expect.poll(() => inputValue(firstPage), { timeout: 30_000 }).toBe(firstSpell.slice(0, 5));
  const restored = await roomSnapshot(firstReconnect, room.roomId);
  expect(restored.selfInput).toBe(firstSpell.slice(0, 5));
  const hostView = await roomSnapshot(host.context, room.roomId);
  expect(hostView.selfInput).not.toBe(restored.selfInput);

  // 该草稿是真实已被接受的前缀：补完其余部分即可完成这道咒文。
  expect(await completeSpell(firstPage)).toBe(firstSpell);
  expect(await battlePhase(host.page)).toBe('playing');

  // 原生运行时恢复：两个客户端都断线，运行时针对同一个数据库与端口重启。
  // 进行中的对局必须连同其身份、绝对截止时间以及每位玩家的已接受状态一起存活。
  const matchIdBefore = await battleMatchId(firstPage);
  const deadlineBefore = await deadline(firstPage);
  const stateBeforeRestart = await roomSnapshot(firstReconnect, room.roomId);
  const guestProgressBefore = snapshotPlayer(stateBeforeRestart, guestIdentity).progress;
  const guestHpBefore = snapshotPlayer(stateBeforeRestart, guestIdentity).hp;
  const hostSpellsBefore = snapshotPlayer(stateBeforeRestart, hostIdentity).spellsCast;
  expect(guestHpBefore).toBeLessThan(INITIAL_HEALTH);

  await host.context.close();
  await firstReconnect.close();
  await harness().restartServer();

  const hostAfter = await newContext(browser);
  const hostPageAfter = await hostAfter.newPage();
  await gotoApp(hostPageAfter, '/');
  await signIn(hostPageAfter, hostIdentity.username);
  await gotoApp(hostPageAfter, `/?room=${room.roomId}`);
  const guestAfter = await newContext(browser);
  const guestPageAfter = await guestAfter.newPage();
  await gotoApp(guestPageAfter, '/');
  await signIn(guestPageAfter, guestName);
  await gotoApp(guestPageAfter, `/?room=${room.roomId}`);
  await Promise.all([waitForCombat(hostPageAfter, 90_000), waitForCombat(guestPageAfter, 90_000)]);

  expect(await battleMatchId(guestPageAfter)).toBe(matchIdBefore);
  expect(await battleMatchId(hostPageAfter)).toBe(matchIdBefore);
  // 截止时间是一个绝对时刻：重新激活既不重置它，也不延长它。
  expect(await deadline(guestPageAfter)).toBe(deadlineBefore);
  const afterRestart = await roomSnapshot(hostAfter, room.roomId);
  expect(afterRestart.startedAt).toBe(stateBeforeRestart.startedAt);
  expect(snapshotPlayer(afterRestart, guestIdentity).progress).toBeGreaterThanOrEqual(
    guestProgressBefore,
  );
  expect(snapshotPlayer(afterRestart, guestIdentity).hp).toBe(guestHpBefore);
  expect(snapshotPlayer(afterRestart, hostIdentity).spellsCast).toBe(hostSpellsBefore);

  // 对局从服务端自身的状态继续：同一本咒文书接着进行，下一次完成照常生效。
  const resumeText = await spellText(hostPageAfter);
  expect(book).toContain(resumeText);
  await completeSpell(hostPageAfter);
  await expect
    .poll(
      async () => snapshotPlayer(await roomSnapshot(hostAfter, room.roomId), guestIdentity).hp,
      { timeout: 30_000 },
    )
    .toBe(guestHpBefore - completionDamage(resumeText));
  expect(await battlePhase(hostPageAfter)).toBe('playing');
  await expect(guestPageAfter.getByTestId('connection-status')).toHaveAttribute(
    'data-state',
    'open',
  );
  // 重连玩家自己的竞技场显示相同的、刚刚结算过的生命值。
  expect(await seatHealth(guestPageAfter, guestIdentity.userId)).toEqual({
    hp: guestHpBefore - completionDamage(resumeText),
    maxHp: INITIAL_HEALTH,
  });

  await hostAfter.close();
  await guestAfter.close();
});
