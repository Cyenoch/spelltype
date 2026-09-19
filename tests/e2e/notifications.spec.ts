/**
 * 游戏事件通知提醒：真实 Service Worker、真实权限流程与真实通知账本，
 * 紧密结合真实的快速匹配边界。
 *
 * 针对完整版 Chromium 构建独立运行（默认的 headless shell 无法投递系统通知）：
 *
 *   bun run test:e2e -- tests/e2e/notifications.spec.ts
 *
 * Service Worker 功能开关本身来自端到端测试 Vite 配置的 `define`
 * （`tests/vite.config.ts` 将 VITE_ENABLE_NOTIFICATIONS_SW 设为 '1'）；不涉及 shell 环境变量。
 *
 * 测试中使用了两项环境模拟器并予以如实标记：按上下文覆盖页面可见性
 * （无头模式 Chromium 缺乏真实的遮挡感知），以及对 `Notification.requestPermission`
 * 进行包装并计数，从而让测试能够证明应用仅在显式点击时才会发起请求。
 * 其余所有部分 —— Service Worker 及其注册、通过 `getNotifications` 回溯读取的已展示通知、
 * Web Locks 账本 —— 均走生产真实路径。目前仍需人工验证的仅剩：操作系统级吐司弹窗的渲染及其物理点击。
 */
import { expect, type Browser, type Page } from '@playwright/test';
import { test } from '../support/test';
import type { MatchTicket } from '../../shared/protocol';
import { fixture, runtime } from '../support/runtime';
import { gameJson, selfIdentity } from '../support/api';
import { gotoApp, openHome, settle } from '../support/app';
import { newContext, signUp, uniqueName, type Session } from '../support/session';

test.use({ channel: 'chromium' });

test.beforeEach(async () => {
  await fixture().reset();
});

const ROOM_ID = /^[0-9a-f]{24}$/;
const MATCHED_TITLE = '匹配成功';
const COUNTDOWN_TITLE = '对局已就绪';
const FINISHED_TITLE = '本局已结束';
const ENABLED_STATE = '已开启对局提醒。';

/** 本测试用例浏览器初始化脚本安装的全局属性。 */
type TestGlobals = {
  __setPageVisibility: (value: string) => void;
  __permissionRequests: number;
  __releaseNotificationLock: () => void;
};

/** 无头模式下无遮挡感知：页面控制自身可见性，模拟真实用户的标签页切换。 */
const VISIBILITY_CONTROL = () => {
  const state = { override: null as string | null };
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state.override ?? 'visible',
  });
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => (state.override ?? 'visible') !== 'visible',
  });
  Object.defineProperty(window, '__setPageVisibility', {
    configurable: true,
    value: (value: string) => {
      state.override = value;
      document.dispatchEvent(new Event('visibilitychange'));
    },
  });
};

/** 统计 requestPermission 调用次数，以便测试证明挂载阶段绝不主动弹窗索权。 */
const PERMISSION_SPY = () => {
  if (!('Notification' in window)) return;
  let requests = 0;
  const native = Notification.requestPermission.bind(Notification);
  Object.defineProperty(Notification, 'requestPermission', {
    configurable: true,
    value: (...args: unknown[]) => {
      requests += 1;
      return (native as (...requestArgs: unknown[]) => Promise<NotificationPermission>)(...args);
    },
  });
  Object.defineProperty(window, '__permissionRequests', {
    configurable: true,
    get: () => requests,
  });
};

/** 安装了可见性与权限监测插桩的已登录上下文。 */
async function reminderSession(
  browser: Browser,
  prefix: string,
  options: { grant?: boolean; blockSw?: boolean } = {},
): Promise<Session> {
  const context = await newContext(browser);
  await context.addInitScript(VISIBILITY_CONTROL);
  await context.addInitScript(PERMISSION_SPY);
  if (options.blockSw) await context.route(/\/sw\.js$/, (route) => route.abort());
  const page = await context.newPage();
  if (options.grant) {
    await context.grantPermissions(['notifications'], { origin: runtime().appUrl });
  }
  const username = uniqueName(prefix);
  await openHome(page);
  await signUp(page, username);
  return { context, page, username };
}

/** 通过真实的 /me 界面启用提醒；在状态提示行确认后返回。 */
async function enableReminders(page: Page): Promise<void> {
  await gotoApp(page, '/me');
  await expect(page.getByTestId('notifications-panel')).toBeVisible();
  await page.getByTestId('notifications-enable').click();
  await expect(page.getByTestId('notifications-state')).toHaveText(ENABLED_STATE);
}

interface ShownNotification {
  title: string;
  tag: string | null;
  data: { roomId?: string; gen?: number } | null;
}

/** Service Worker 当前为该源地址持有的所有通知。 */
async function shownList(page: Page): Promise<ShownNotification[]> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return [];
    const shown = await registration.getNotifications();
    return shown.map((notification) => ({
      title: notification.title,
      tag: notification.tag,
      data: notification.data ?? null,
    }));
  });
}

const hide = (page: Page) =>
  page.evaluate(() => (window as unknown as TestGlobals).__setPageVisibility('hidden'));

/** 由 PERMISSION_SPY 安装的页面 requestPermission 计数器。 */
const permissionRequests = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as TestGlobals).__permissionRequests);

/** 通过 UI 让两名玩家同时排队；返回双方共同进入的房间号。 */
async function quickMatchViaUi(first: Session, second: Session): Promise<string> {
  await gotoApp(first.page, '/');
  await first.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('view-queue')).toBeVisible();
  await openHome(second.page);
  await second.page.getByTestId('home-quick-start').click();
  for (const page of [first.page, second.page]) {
    await expect(page.getByTestId('view-room')).toBeVisible({ timeout: 40_000 });
  }
  const roomId = (await first.page.getByTestId('view-room').getAttribute('data-room-id')) ?? '';
  expect(roomId).toMatch(ROOM_ID);
  const otherRoom = (await second.page.getByTestId('view-room').getAttribute('data-room-id')) ?? '';
  expect(otherRoom).toBe(roomId);
  return roomId;
}

test('提醒只在显式点击后开启，后台匹配成功收到一条真实系统通知', async ({ browser }) => {
  const first = await reminderSession(browser, 'ntf1', { grant: true });
  const second = await reminderSession(browser, 'ntf2');

  // 挂载不会自发索权：面板渲染，计数器保持为零。
  await gotoApp(first.page, '/me');
  await expect(first.page.getByTestId('notifications-panel')).toBeVisible();
  await expect(first.page.getByTestId('notifications-enable')).toBeVisible();
  expect(await permissionRequests(first.page)).toBe(0);

  // 权限已预先授予；用户手势点击即可启用，无需再次弹出浏览器提示。
  await first.page.getByTestId('notifications-enable').click();
  await expect(first.page.getByTestId('notifications-state')).toHaveText(ENABLED_STATE);

  // 开关属于用户而非单个页面实例：刷新重新加载后保持开启，
  // 且不消耗额外的权限请求。
  await gotoApp(first.page, '/me');
  await expect(first.page.getByTestId('notifications-state')).toHaveText(ENABLED_STATE);
  expect(await permissionRequests(first.page)).toBe(0);

  await gotoApp(first.page, '/');
  await first.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting');
  await hide(first.page);

  await fixture().setDelay(6000);
  await openHome(second.page);
  await second.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('view-room')).toBeVisible({ timeout: 40_000 });
  const roomId = (await first.page.getByTestId('view-room').getAttribute('data-room-id')) ?? '';
  expect(roomId).toMatch(ROOM_ID);

  const { userId } = await selfIdentity(first.context);
  await expect.poll(() => shownList(first.page), { timeout: 20_000 }).toHaveLength(1);
  const [matched] = await shownList(first.page);
  expect(matched.title).toBe(MATCHED_TITLE);
  expect(matched.tag).toBe(`spelltype:${userId}:${roomId}`);
  expect(matched.data?.roomId).toBe(roomId);

  // 同一租约再次响应属于同一事件：不重复弹出通知。
  const again = await gameJson<MatchTicket>(first.context, '/match', { method: 'POST' });
  expect(again.body.state).toBe('matched');
  await settle(1500);
  expect(await shownList(first.page)).toHaveLength(1);

  await first.context.close();
  await second.context.close();
});

test('前台页面匹配成功不产生系统通知', async ({ browser }) => {
  const first = await reminderSession(browser, 'ntf3', { grant: true });
  const second = await reminderSession(browser, 'ntf4');

  await enableReminders(first.page);
  await fixture().setDelay(6000);
  const roomId = await quickMatchViaUi(first, second);

  // 页面在整场对决中保持可见：通知要传达的所有信息均已展示在屏幕上，
  // 因此不生成任何通知。
  await settle(2000);
  expect(await shownList(first.page)).toHaveLength(0);
  expect(roomId).toMatch(ROOM_ID);

  await first.context.close();
  await second.context.close();
});

test('开赛前弃赛：倒计时提醒被唯一的结束通知替换', async ({ browser }) => {
  const first = await reminderSession(browser, 'ntf5', { grant: true });
  const second = await reminderSession(browser, 'ntf6');

  await enableReminders(first.page);
  await gotoApp(first.page, '/');
  await first.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting');
  await hide(first.page);

  await fixture().setDelay(1000);
  await openHome(second.page);
  await second.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('view-room')).toBeVisible({ timeout: 40_000 });
  const roomId = (await first.page.getByTestId('view-room').getAttribute('data-room-id')) ?? '';

  // 隐藏的页面仍恰好经历一次生成 → 倒计时。
  await expect
    .poll(async () => (await shownList(first.page)).map((shown) => shown.title), {
      timeout: 20_000,
    })
    .toContain(COUNTDOWN_TITLE);
  expect(await shownList(first.page)).toHaveLength(1);

  // 对手在战斗前离开：房间未进入对战便直接结算。
  // 完赛提醒替换倒计时提醒（相同 tag）—— 依然只有单条通知。
  await gameJson(second.context, `/rooms/${roomId}/leave`, { method: 'POST' });
  await expect
    .poll(async () => (await shownList(first.page)).map((shown) => shown.title), {
      timeout: 20_000,
    })
    .toEqual([FINISHED_TITLE]);
  await settle(1500);
  expect(await shownList(first.page)).toHaveLength(1);

  await first.context.close();
  await second.context.close();
});

test('离开房间会使已显示的提醒立即失效', async ({ browser }) => {
  const first = await reminderSession(browser, 'ntf7', { grant: true });
  const second = await reminderSession(browser, 'ntf8');

  await enableReminders(first.page);
  await gotoApp(first.page, '/');
  await first.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting');
  await hide(first.page);

  await fixture().setDelay(1000);
  await openHome(second.page);
  await second.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('view-room')).toBeVisible({ timeout: 40_000 });

  await expect
    .poll(async () => (await shownList(first.page)).map((shown) => shown.title), {
      timeout: 20_000,
    })
    .toContain(COUNTDOWN_TITLE);

  // 玩家从（隐藏的）房间界面主动离开；提醒绝不能比它所指向的席位活得更久。
  await first.page.getByTestId('battle-leave').click();
  await expect(first.page.getByTestId('view-home')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => shownList(first.page), { timeout: 20_000 }).toHaveLength(0);

  await first.context.close();
  await second.context.close();
});

test('注销会取消仍在等待发送的提醒', async ({ browser }) => {
  const first = await reminderSession(browser, 'ntf9', { grant: true });
  const second = await reminderSession(browser, 'ntf10');

  await enableReminders(first.page);
  const { userId } = await selfIdentity(first.context);
  const lockPage = await first.context.newPage();
  await gotoApp(lockPage, '/');

  // 将锁保留在独立的文档中：导航正在游戏的页面会释放该文档持有的所有锁，
  // 从而破坏预期的竞态窗口。
  await lockPage.evaluate((lockName) => {
    const acquired = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    Object.defineProperty(window, '__releaseNotificationLock', {
      configurable: true,
      value: held.resolve,
    });
    void navigator.locks.request(lockName, () => {
      acquired.resolve();
      return held.promise;
    });
    return acquired.promise;
  }, `spelltype:notifications:${userId}`);

  await gotoApp(first.page, '/');
  await first.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting');
  await hide(first.page);

  await fixture().setDelay(6000);
  await openHome(second.page);
  await second.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('view-room')).toBeVisible({ timeout: 40_000 });
  await settle(1500);
  // 尝试被卡在锁后面：当前尚未展示任何通知。
  expect(await shownList(first.page)).toHaveLength(0);

  // 登出会使该账号挂起的尝试失效……
  await first.page.getByTestId('sign-out').click();
  await expect(first.page.getByTestId('nav-username')).toBeHidden();

  // ……因此即便锁被释放，迟到的提醒也绝不会发出。
  await lockPage.evaluate(() => (window as unknown as TestGlobals).__releaseNotificationLock());
  await settle(1500);
  expect(await shownList(first.page)).toHaveLength(0);

  await first.context.close();
  await second.context.close();
});

test('权限被拒或注册失败都不妨碍匹配与输入', async ({ browser }) => {
  // 未授权：显式点击到达浏览器并在浏览器层被拒绝。
  const denied = await reminderSession(browser, 'ntf11');
  await gotoApp(denied.page, '/me');
  expect(await permissionRequests(denied.page)).toBe(0);
  await denied.page.getByTestId('notifications-enable').click();
  await expect(denied.page.getByTestId('notifications-state')).toContainText('拒绝');
  expect(await permissionRequests(denied.page)).toBe(1);

  // Service Worker 注册损坏被识别为不支持，而非抛出报错墙。
  const blocked = await reminderSession(browser, 'ntf12', { blockSw: true });
  await gotoApp(blocked.page, '/me');
  await expect(blocked.page.getByTestId('notifications-state')).toContainText('不支持', {
    timeout: 20_000,
  });

  // 双方完成一场完整对战：匹配、房间与打字输入完全不受上述异常影响，
  // 且两端均未弹出通知。
  await fixture().setDelay(2000);
  await gotoApp(denied.page, '/');
  await denied.page.getByTestId('home-quick-start').click();
  await openHome(blocked.page);
  await blocked.page.getByTestId('home-quick-start').click();
  for (const page of [denied.page, blocked.page]) {
    await expect(page.getByTestId('view-room')).toBeVisible({ timeout: 40_000 });
    await expect(page.getByTestId('typing-input')).toBeVisible({ timeout: 60_000 });
    expect(await shownList(page)).toHaveLength(0);
  }

  await denied.context.close();
  await blocked.context.close();
});
