/**
 * 私人房容量与准入：四个席位，第五名玩家被拒绝，
 * 以及既有账号的第二次连接只保留一个席位、绝不新增第五个。
 *
 * 房间创建表单本身是所有保留场景都已驱动的路径
 * （`createRoom` 会打开创建视图、填写主题并提交），
 * 因此本测试只在其上补充容量规则。未知房间 id 由 auth 测试覆盖，
 * 同源/请求体/Cookie 边界由单元测试套件覆盖。
 */
import { expect } from '@playwright/test';
import { test } from '../support/test';
import { fixture } from '../support/runtime';
import { gotoApp, visibleErrorText } from '../support/app';
import { createRoom, occupiedSeat, occupiedSeats, waitForLobbyPlayers } from '../support/lobby';
import { signedInContext, type Session } from '../support/session';

test.beforeEach(async () => {
  await fixture().reset();
});

test('私人房容纳四名玩家，第五人被拒，重复连接不占额外席位', async ({ browser }) => {
  test.setTimeout(240_000);
  const host = await signedInContext(browser, 'cap0');
  const roomId = await createRoom(host.page, { theme: '四席试炼' });

  const others: Session[] = [];
  for (const index of [1, 2, 3]) others.push(await signedInContext(browser, `cap${index}`));
  for (const other of others) {
    await gotoApp(other.page, `/?room=${roomId}`);
    await expect(other.page.getByTestId('lobby-panel')).toBeVisible();
  }
  await waitForLobbyPlayers(host.page, [host.username, ...others.map((other) => other.username)]);
  expect(await occupiedSeats(host.page).count()).toBe(4);

  // 第五名玩家：满员房间必须被拒绝，并给出可见的解释。
  const fifth = await signedInContext(browser, 'cap4');
  await gotoApp(fifth.page, `/?room=${roomId}`);
  await expect.poll(() => visibleErrorText(fifth.page), { timeout: 20_000 }).not.toBe('');
  await expect(fifth.page.getByTestId('lobby-panel')).toBeHidden();
  expect(await occupiedSeats(host.page).count()).toBe(4);

  // 同一账号开启第二条连接时只保留一个席位，而不会占用第五个；
  // 且当第二条连接仍存活时，该席位在第一个标签页关闭后依然保留。
  const duplicatePage = await others[0].context.newPage();
  await gotoApp(duplicatePage, `/?room=${roomId}`);
  await expect(duplicatePage.getByTestId('lobby-panel')).toBeVisible();
  expect(await occupiedSeats(host.page).count()).toBe(4);
  await others[0].page.close();
  await expect(occupiedSeat(host.page, others[0].username)).toHaveAttribute(
    'data-connected',
    'true',
  );
  expect(await occupiedSeats(host.page).count()).toBe(4);

  await duplicatePage.context().close();
  await fifth.context.close();
  for (const other of others) await other.context.close();
  await host.context.close();
});
