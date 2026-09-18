/**
 * Private-room capacity and admission: four seats, a fifth player refused, and a second connection
 * for an existing account that keeps one seat and never adds a fifth.
 *
 * The room-creation form itself is the path every retained scenario already drives (`createRoom`
 * opens the create view, fills the theme and submits), so this spec adds only
 * the capacity rules on top. Unknown room ids are covered by the auth spec, and the
 * same-origin/body/cookie boundary by the unit suites.
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

  // Fifth player: a full room must be refused with a visible explanation.
  const fifth = await signedInContext(browser, 'cap4');
  await gotoApp(fifth.page, `/?room=${roomId}`);
  await expect.poll(() => visibleErrorText(fifth.page), { timeout: 20_000 }).not.toBe('');
  await expect(fifth.page.getByTestId('lobby-panel')).toBeHidden();
  expect(await occupiedSeats(host.page).count()).toBe(4);

  // The same account opening a second connection keeps one seat instead of taking a fifth, and the
  // seat survives the first tab closing while the second connection lives.
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
