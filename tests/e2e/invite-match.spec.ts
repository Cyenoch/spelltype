/**
 * 邀请链路端到端测试：未登录访客打开邀请链接、创建账号、
 * 加入私人大厅，两名真实玩家完成一场完整的对局直至结果持久化。
 *
 * 这是唯一在单次运行中覆盖“大厅 → 生成 → 倒计时 → 战斗 → 结算 → 战绩历史”的测试用例，
 * 因而属于黄金路径：房间的法术书送达双方客户端，施法完成对自动目标造成伤害，
 * 并且双方玩家读取相同的榜单与相同的持久化数据行。
 */
import { expect } from '@playwright/test';
import { test } from '../support/test';
import { INITIAL_HEALTH } from '../../shared/protocol';
import { acceptedGeneration, fixture } from '../support/runtime';
import {
  battleMatchId,
  completeSpell,
  completionDamage,
  endReason,
  finalRows,
  playUntilFinished,
  resultBanner,
  saveStatus,
  seatHealth,
  selfSpellIndex,
  selfSpellsCast,
  spellText,
  waitForCombat,
  waitForMatchEnd,
} from '../support/combat';
import { rowFor, selfIdentity } from '../support/api';
import { gotoApp } from '../support/app';
import {
  createRoom,
  occupiedSeat,
  occupiedSeats,
  setReady,
  startMatch,
  waitForLobbyPlayers,
} from '../support/lobby';
import { historyRows, openProfile } from '../support/profile';
import { newContext, signUp, signedInContext, uniqueName } from '../support/session';

test.beforeEach(async () => {
  await fixture().reset();
});

test('受邀玩家登录后加入，两名玩家完成整场对战后看到相同战绩', async ({ browser }) => {
  // 保留一条完整的动画匹配/重赛路径；其余场景使用无动画模式。
  test.setTimeout(300_000);
  const host = await signedInContext(browser, 'host');
  await host.page.emulateMedia({ reducedMotion: 'no-preference' });
  const theme = '星陨图书馆的禁忌抄本';
  // 困难法术每条造成约 176 点伤害，因此 2400 HP 的对手大约在 14 次施法完成后出局。
  const roomId = await createRoom(host.page, { theme });

  expect(await occupiedSeats(host.page).count()).toBe(1);
  expect(await host.page.getByTestId('room-theme').textContent()).toContain(theme);
  // 邀请码即为房间号本身：大厅予以展示并提供复制操作。
  await expect(host.page.getByTestId('lobby-room-id')).toHaveText(roomId);
  await expect(host.page.getByTestId('lobby-copy-room-id')).toBeVisible();

  // 未登录访客通过主页对话框输入邀请码加入：目标地址在认证流程中得以保留。
  // 格式错误的房间号会保持对话框开启并高亮输入框；大写输入与多余空格在解析房间前会被裁剪并转为小写。
  const guestContext = await newContext(browser, { reducedMotion: 'no-preference' });
  const guestPage = await guestContext.newPage();
  await gotoApp(guestPage, '/');
  await guestPage.getByTestId('home-join-room').click();
  await expect(guestPage.getByTestId('join-room-dialog')).toBeVisible();
  await guestPage.getByTestId('join-room-code').fill('g'.repeat(24));
  await guestPage.getByTestId('join-room-submit').click();
  await expect(guestPage.getByTestId('join-room-dialog')).toBeVisible();
  await expect(guestPage.getByTestId('join-room-code')).toHaveAttribute('aria-invalid', 'true');
  await guestPage.getByTestId('join-room-code').fill(`  ${roomId.toUpperCase()}  `);
  await guestPage.getByTestId('join-room-submit').click();
  await expect(guestPage.getByTestId('view-auth')).toBeVisible();
  await expect(guestPage.getByTestId('invite-notice')).toContainText(roomId);
  const guestName = uniqueName('guest');
  await signUp(guestPage, guestName);
  await expect(guestPage.getByTestId('view-room')).toBeVisible();
  await expect(guestPage.getByTestId('lobby-panel')).toBeVisible();

  await waitForLobbyPlayers(host.page, [host.username, guestName]);
  await setReady(guestPage, true);
  await expect(occupiedSeat(host.page, guestName)).toHaveAttribute('data-ready', 'true');
  await fixture().setDelay(6000);

  await host.page.getByTestId('lobby-start').click();
  for (const page of [host.page, guestPage]) {
    await expect(page.getByTestId('view-generation')).toBeVisible();
    await expect(page.getByTestId('battle-panel')).toBeHidden();
  }
  await expect(guestPage.getByTestId('battle-panel')).toBeVisible({ timeout: 30_000 });
  await Promise.all([waitForCombat(host.page), waitForCombat(guestPage)]);

  // 对局确实向模型请求了一本法术书，且双方客户端按顺序拿到了该书。
  const book = acceptedGeneration(await fixture().state()).generation.texts;

  const hostIdentity = await selfIdentity(host.context);
  const guestIdentity = await selfIdentity(guestContext);

  // 双方玩家从共享法术书的同一条法术开始，完成施法仅推进完成者自身的游标：无人需要等待对手回应。
  expect(await spellText(host.page)).toBe(book[0]);
  expect(await spellText(guestPage)).toBe(book[0]);
  expect(await selfSpellIndex(host.page)).toBe(0);
  expect(await completeSpell(host.page)).toBe(book[0]);
  expect(await selfSpellIndex(host.page)).toBe(1);
  expect(await spellText(host.page)).toBe(book[1]);
  expect(await spellText(guestPage)).toBe(book[0]);
  expect(await selfSpellsCast(guestPage)).toBe(0);

  // 访客切实发起反击：两次施法完成的伤害必须展示在房主自身的席位上。
  const guestSpells = [await completeSpell(guestPage), await completeSpell(guestPage)];
  expect(guestSpells).toEqual([book[0], book[1]]);
  const guestDamage = guestSpells.reduce((sum, text) => sum + completionDamage(text), 0);
  await expect
    .poll(async () => (await seatHealth(host.page, hostIdentity.userId)).hp)
    .toBe(INITIAL_HEALTH - guestDamage);

  // 房主完成单场战斗阶段剩余的施法；访客的生命值率先耗尽。
  await playUntilFinished(host.page);
  await Promise.all([waitForMatchEnd(host.page), waitForMatchEnd(guestPage)]);
  expect(await endReason(host.page)).toBe('elimination');
  const matchIdValue = await battleMatchId(host.page);

  const hostRows = await finalRows(host.page);
  const guestRows = await finalRows(guestPage);
  expect(hostRows).toHaveLength(2);
  expect(hostRows.map((row) => row.rank).sort((a, b) => a - b)).toEqual([1, 2]);

  const hostRow = rowFor(hostRows, hostIdentity)!;
  const guestRow = rowFor(hostRows, guestIdentity)!;
  // 胜者为最后存活的玩家；对手在恰好 0 HP 时被淘汰。
  expect(hostRow.rank).toBe(1);
  expect(guestRow.rank).toBe(2);
  expect(guestRow.hp).toBe(0);

  // 双方查看者读取相同的榜单：每个身份一行，两端页面完全一致。
  for (const identity of [hostIdentity, guestIdentity]) {
    const fromHost = rowFor(hostRows, identity)!;
    const fromGuest = rowFor(guestRows, identity)!;
    expect(fromGuest.rank).toBe(fromHost.rank);
    expect(fromGuest.hp).toBe(fromHost.hp);
    expect(fromGuest.damage).toBe(fromHost.damage);
    expect(fromGuest.spells).toBe(fromHost.spells);
  }

  // 结算以专属且立即可见的结果页面取代战斗界面。
  const banner = await resultBanner(host.page);
  expect(banner.outcome).toBe('win');
  expect(banner.endReason).toBe('elimination');
  expect((await resultBanner(guestPage)).outcome).toBe('loss');
  for (const [page, title] of [
    [host.page, '胜利'],
    [guestPage, '失败'],
  ] as const) {
    await expect(page.getByTestId('view-results')).toBeVisible();
    await expect(page.getByTestId('battle-panel')).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeInViewport();
    await expect(page.getByTestId('rematch')).toBeInViewport();
    await expect(page.getByTestId('result-title')).toBeFocused();
  }

  await expect.poll(() => saveStatus(host.page), { timeout: 30_000 }).toBe('saved');

  // 第二局比赛必须复用活着的竞技场实例，而不是渲染到已脱钩的第一局容器中。
  await host.page.getByTestId('rematch').click();
  await expect(host.page.getByTestId('lobby-panel')).toBeVisible();
  await expect(guestPage.getByTestId('lobby-panel')).toBeVisible();
  await expect(host.page.getByTestId('view-results')).toBeHidden();
  await expect(guestPage.getByTestId('view-results')).toBeHidden();
  await setReady(guestPage, true);
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guestPage)]);
  expect(await battleMatchId(host.page)).not.toBe(matchIdValue);
  await expect(host.page.getByTestId('battle-canvas-wrap').locator('canvas')).toBeVisible();
  await completeSpell(host.page);
  expect(await selfSpellsCast(host.page)).toBe(1);

  // 持久化的历史战绩行是本场对决的战斗记录，双方玩家均能查阅。
  await openProfile(host.page);
  const hostEntry = (await historyRows(host.page)).find((row) => row.matchId === matchIdValue);
  expect(hostEntry).toBeDefined();
  expect(hostEntry!.theme).toContain(theme);
  expect(hostEntry!.rank).toBe(hostRow.rank);
  expect(hostEntry!.damage).toBe(hostRow.damage);
  expect(hostEntry!.hp).toBe(hostRow.hp);

  await openProfile(guestPage);
  const guestHistory = await historyRows(guestPage);
  expect(guestHistory.filter((row) => row.matchId === matchIdValue)).toHaveLength(1);
  const guestEntry = guestHistory.find((row) => row.matchId === matchIdValue)!;
  expect(guestEntry.rank).toBe(guestRow.rank);
  expect(guestEntry.damage).toBe(guestRow.damage);
  expect(guestEntry.hp).toBe(guestRow.hp);
  expect(guestEntry.rank).not.toBe(hostEntry!.rank);

  await host.context.close();
  await guestContext.close();
});
