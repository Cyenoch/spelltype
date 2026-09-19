/**
 * The one global maintenance window, driven end to end through the admin console and observed
 * exactly as a player does.
 *
 * Draining is durable database state, not a per-page flag: entering it from the console must
 * reach every open page through the status poll — the shell explains the window, every entrance
 * that could start a match goes dark, and everything a player already owns keeps working: the
 * live socket, typing, manual leave and queue cancellation. Resuming flips every page back
 * without anyone reloading. The console itself is admin-only (session role; the API re-checks on
 * every call), quotes the revision it acts on (CAS), and a status outage on the player side is
 * the honest "unknown": new starts fail closed there too, and recover on their own.
 */
import { expect, type Page } from '@playwright/test';
import { test } from '../support/test';
import { apiJson, gameJson } from '../support/api';
import { gotoApp, openHome } from '../support/app';
import { completeSpell, waitForCombat } from '../support/combat';
import { startMatch, twoPlayerRoom } from '../support/lobby';
import { fixture } from '../support/runtime';
import { adminContext, signedInContext, type Session } from '../support/session';

interface MarkerWindow extends Window {
  __maintenanceMarker?: string;
}

test.beforeEach(async () => {
  await fixture().reset();
});

/** Parks a value on the window that only a full reload could erase. */
async function plantReloadMarker(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as MarkerWindow).__maintenanceMarker = 'alive';
  });
}

function readReloadMarker(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (window as MarkerWindow).__maintenanceMarker);
}

/** Opens the console in an admin session and drives one transition through the real UI (CAS). */
async function driveConsole(
  admin: Session,
  action: 'admin-drain' | 'admin-resume',
  expectedMode: 'open' | 'draining',
): Promise<void> {
  await gotoApp(admin.page, '/admin/maintenance');
  const mode = admin.page.getByTestId('admin-maintenance-mode');
  await expect(mode).toBeVisible({ timeout: 20_000 });
  if ((await mode.getAttribute('data-mode')) === expectedMode) return;
  await admin.page.getByTestId(action).click();
  await expect(mode).toHaveAttribute('data-mode', expectedMode, { timeout: 20_000 });
}

test('维护控制台：管理员进入与结束维护，玩家页面随之开关入口', async ({ browser }) => {
  const admin = await adminContext(browser, 'maint-admin');
  const player = await signedInContext(browser, 'maint');
  await openHome(player.page);
  await expect(player.page.getByTestId('maintenance-banner')).toHaveCount(0);
  await expect(player.page.getByTestId('home-quick-start')).toBeEnabled();
  await expect(player.page.getByTestId('home-create')).toBeEnabled();

  await driveConsole(admin, 'admin-drain', 'draining');
  try {
    // The status poll (~15s worst case) carries the window to the open page.
    const banner = player.page.getByTestId('maintenance-banner');
    await expect(banner).toBeVisible({ timeout: 25_000 });
    await expect(banner).toContainText('系统维护中');
    await expect(banner).toContainText('维护结束后即可重新匹配');
    await expect(player.page.getByTestId('home-quick-start')).toBeDisabled();
    await expect(player.page.getByTestId('home-create')).toBeDisabled();
    await expect(player.page.getByTestId('home-service-notice')).toBeVisible();
    await expect(player.page.getByTestId('home-service-notice')).toHaveAttribute(
      'data-state',
      'draining',
    );

    // Resuming must reach the very same page: no reload, no manual action.
    await plantReloadMarker(player.page);
    await driveConsole(admin, 'admin-resume', 'open');
    await expect(banner).toBeHidden({ timeout: 25_000 });
    await expect(player.page.getByTestId('home-quick-start')).toBeEnabled({ timeout: 25_000 });
    await expect(player.page.getByTestId('home-service-notice')).toBeHidden();
    expect(await readReloadMarker(player.page)).toBe('alive');
  } finally {
    // Recovery path if an assertion above died mid-window.
    await driveConsole(admin, 'admin-resume', 'open');
  }
  await admin.context.close();
  await player.context.close();
});

test('控制台按钮随维护状态切换，重复操作不可用', async ({ browser }) => {
  const admin = await adminContext(browser, 'count-admin');
  await gotoApp(admin.page, '/admin/maintenance');
  const mode = admin.page.getByTestId('admin-maintenance-mode');

  await expect(mode).toHaveAttribute('data-mode', 'open', { timeout: 20_000 });
  await expect(admin.page.getByTestId('admin-resume')).toBeDisabled();
  await expect(admin.page.getByTestId('admin-drain')).toBeEnabled();

  // While draining, the console mirrors the blocked state instead of the open one.
  await admin.page.getByTestId('admin-drain').click();
  await expect(mode).toHaveAttribute('data-mode', 'draining', { timeout: 20_000 });
  await expect(admin.page.getByTestId('admin-drain')).toBeDisabled();
  await expect(admin.page.getByTestId('admin-resume')).toBeEnabled();

  await admin.page.getByTestId('admin-resume').click();
  await expect(mode).toHaveAttribute('data-mode', 'open', { timeout: 20_000 });
  await admin.context.close();
});

test('排队遇到维护：排队如实终止，取消仍可用', async ({ browser }) => {
  const admin = await adminContext(browser, 'queue-admin');
  const first = await signedInContext(browser, 'mdrain');
  await openHome(first.page);
  await first.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting', {
    timeout: 20_000,
  });

  await driveConsole(admin, 'admin-drain', 'draining');
  try {
    // The next poll is refused: the search is over, honestly explained.
    const state = first.page.getByTestId('queue-state');
    await expect(state).toHaveAttribute('data-state', 'maintenance', { timeout: 25_000 });
    await expect(state).toContainText('维护中');
    // While maintenance holds, the page cannot pretend the search may continue.
    await expect(first.page.getByTestId('queue-requeue')).toBeHidden();

    // Cancellation works during maintenance — nothing left to cancel is still a success.
    await first.page.getByTestId('queue-cancel').click();
    await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'cancelled', {
      timeout: 20_000,
    });
  } finally {
    await driveConsole(admin, 'admin-resume', 'open');
  }
  await admin.context.close();
  await first.context.close();
});

test('服务状态不可知时同样关闭新入口：恢复后自动放开', async ({ browser }) => {
  const session = await signedInContext(browser, 'moutage');
  await openHome(session.page);

  await session.page.route('**/api/status', (route) => route.abort('connectionfailed'));
  try {
    // A failed status lookup is "unknown", and unknown fails closed.
    const banner = session.page.getByTestId('status-unavailable-banner');
    await expect(banner).toBeVisible({ timeout: 25_000 });
    await expect(banner).toContainText('暂时无法获取服务状态');
    await expect(session.page.getByTestId('home-quick-start')).toBeDisabled();
    await expect(session.page.getByTestId('home-create')).toBeDisabled();

    // Recovery is the poll's job too: the same page reopens without a reload.
    await session.page.unroute('**/api/status');
    await expect(banner).toBeHidden({ timeout: 25_000 });
    await expect(session.page.getByTestId('home-quick-start')).toBeEnabled({ timeout: 25_000 });
    await expect(session.page.getByTestId('maintenance-banner')).toHaveCount(0);
  } finally {
    await session.page.unroute('**/api/status');
  }
  await session.context.close();
});

test('维护不打断进行中的对局：输入继续、离开可用，再来一局被暂停', async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await adminContext(browser, 'combat-admin');
  const room = await twoPlayerRoom(browser, { theme: '维护中继续对局' });
  await fixture().setDelay(6000);
  await startMatch(room.host.page);
  await Promise.all([waitForCombat(room.host.page), waitForCombat(room.guest.page)]);

  await driveConsole(admin, 'admin-drain', 'draining');
  try {
    // The live socket stays open and the field keeps working: the match is not
    // interrupted, and the page is never reloaded out from under the player.
    await plantReloadMarker(room.host.page);
    await expect(room.host.page.getByTestId('maintenance-banner')).toBeVisible({
      timeout: 25_000,
    });
    await expect(room.host.page.getByTestId('connection-status')).toHaveAttribute(
      'data-state',
      'open',
    );
    await completeSpell(room.host.page);
    expect(await readReloadMarker(room.host.page)).toBe('alive');

    // Leaving is always available — also mid-combat during maintenance.
    const leave = await gameJson<{ left: boolean }>(
      room.guest.context,
      `/rooms/${room.roomId}/leave`,
      { method: 'POST' },
    );
    expect(leave.status).toBe(200);
    expect(leave.body.left).toBe(true);

    // The host's match settles; the next match is paused, not the page.
    await expect(room.host.page.getByTestId('view-results')).toBeVisible({ timeout: 30_000 });
    await expect(room.host.page.getByTestId('rematch')).toBeDisabled();
    await expect(room.host.page.getByTestId('final-leave')).toBeEnabled();
    expect(await readReloadMarker(room.host.page)).toBe('alive');

    // Resuming re-enables the rematch on the very same page.
    await driveConsole(admin, 'admin-resume', 'open');
    await expect(room.host.page.getByTestId('rematch')).toBeEnabled({ timeout: 25_000 });
    expect(await readReloadMarker(room.host.page)).toBe('alive');
  } finally {
    await driveConsole(admin, 'admin-resume', 'open');
  }
  await admin.context.close();
  await room.host.context.close();
  await room.guest.context.close();
});

test('维护控制台只属于管理员：入口隐藏、直达被拒、接口拒绝非管理员', async ({ browser }) => {
  const player = await signedInContext(browser, 'notadmin');

  // The navigation hides the console; a direct visit bounces back home.
  await openHome(player.page);
  await expect(player.page.getByTestId('nav-admin')).toHaveCount(0);
  await gotoApp(player.page, '/admin/maintenance');
  await expect(player.page.getByTestId('view-home')).toBeVisible();
  await expect(player.page.getByTestId('view-admin-maintenance')).toHaveCount(0);

  // The server is the authority: the console API refuses a plain user twice over.
  expect((await apiJson(player.context, '/api/admin/maintenance')).status).toBe(403);
  expect(
    (
      await apiJson(player.context, '/api/admin/maintenance', {
        method: 'POST',
        data: { mode: 'draining', expectedRevision: 0 },
      })
    ).status,
  ).toBe(403);
  await player.context.close();

  // A guest is refused before the role is even considered.
  const anonymous = await browser.newContext();
  expect((await apiJson(anonymous, '/api/admin/maintenance')).status).toBe(401);
  await anonymous.close();
});
