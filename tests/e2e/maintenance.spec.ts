/**
 * 全局唯一定期维护窗口，通过管理员控制台端到端驱动，并完全从玩家视角进行观测。
 *
 * 排空中状态是持久化数据库状态，而非页面级标志：从控制台进入该状态后，必须通过状态轮询同步至每个已打开的页面 ——
 * 页面外壳展示维护说明，所有可能开启新对局的入口均置灰停用，而玩家已拥有的所有资源保持可用：
 * 活动中的 socket、打字、手动离场和排队取消。恢复开放会在无需刷新的情况下将所有页面还原。
 * 控制台自身仅限管理员访问（会话角色；API 每次调用均重新校验），带有执行操作时的修订号（CAS）；
 * 玩家侧的状态接口中断如实展示为“状态未知”：此时新对局同样失败关闭，并在恢复后自行重新开放。
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

/** 在 window 上植入一个只有完整刷新页面才会清除的标记值。 */
async function plantReloadMarker(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as MarkerWindow).__maintenanceMarker = 'alive';
  });
}

function readReloadMarker(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (window as MarkerWindow).__maintenanceMarker);
}

/** 在管理员会话中打开控制台，并通过真实 UI 驱动一次状态转换（CAS）。 */
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
    // 状态轮询（最差情况约 15 秒）将维护窗口信息同步到已打开的页面。
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

    // 恢复开放必须触达同一个页面：无需重新加载，无需手动干预。
    await plantReloadMarker(player.page);
    await driveConsole(admin, 'admin-resume', 'open');
    await expect(banner).toBeHidden({ timeout: 25_000 });
    await expect(player.page.getByTestId('home-quick-start')).toBeEnabled({ timeout: 25_000 });
    await expect(player.page.getByTestId('home-service-notice')).toBeHidden();
    expect(await readReloadMarker(player.page)).toBe('alive');
  } finally {
    // 若上方断言在中途挂掉的兜底恢复路径。
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

  // 排空中状态下，控制台反映阻止状态而非开放状态。
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
    // 下一次轮询被拒绝：匹配如实终止并展示说明。
    const state = first.page.getByTestId('queue-state');
    await expect(state).toHaveAttribute('data-state', 'maintenance', { timeout: 25_000 });
    await expect(state).toContainText('维护中');
    // 维护期间，页面不能假装搜索仍在继续。
    await expect(first.page.getByTestId('queue-requeue')).toBeHidden();

    // 维护期间取消操作依然可用 —— 即使无可取消项也如实返回成功。
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
    // 状态查询失败即为“未知状态”，未知状态一律失败关闭。
    const banner = session.page.getByTestId('status-unavailable-banner');
    await expect(banner).toBeVisible({ timeout: 25_000 });
    await expect(banner).toContainText('暂时无法获取服务状态');
    await expect(session.page.getByTestId('home-quick-start')).toBeDisabled();
    await expect(session.page.getByTestId('home-create')).toBeDisabled();

    // 恢复同样由轮询负责：同一个页面无需刷新即可重新开放。
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
    // 活动 socket 保持打开，输入框保持可用：比赛未被打断，
    // 也绝不会在玩家毫不知情的情况下刷新页面。
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

    // 离开随时可用 —— 即使在维护期间的战斗中途也同样可用。
    const leave = await gameJson<{ left: boolean }>(
      room.guest.context,
      `/rooms/${room.roomId}/leave`,
      { method: 'POST' },
    );
    expect(leave.status).toBe(200);
    expect(leave.body.left).toBe(true);

    // 房主的比赛正常结算；暂停的是下一局对局，而非页面本身。
    await expect(room.host.page.getByTestId('view-results')).toBeVisible({ timeout: 30_000 });
    await expect(room.host.page.getByTestId('rematch')).toBeDisabled();
    await expect(room.host.page.getByTestId('final-leave')).toBeEnabled();
    expect(await readReloadMarker(room.host.page)).toBe('alive');

    // 恢复开放将在完全相同的页面上重新启用重赛功能。
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

  // 导航栏隐藏控制台；直接访问会跳回主页。
  await openHome(player.page);
  await expect(player.page.getByTestId('nav-admin')).toHaveCount(0);
  await gotoApp(player.page, '/admin/maintenance');
  await expect(player.page.getByTestId('view-home')).toBeVisible();
  await expect(player.page.getByTestId('view-admin-maintenance')).toHaveCount(0);

  // 服务端是最终权威：控制台 API 严格拒绝普通用户。
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

  // 访客在核验角色之前就被直接拒绝。
  const anonymous = await browser.newContext();
  expect((await apiJson(anonymous, '/api/admin/maintenance')).status).toBe(401);
  await anonymous.close();
});
