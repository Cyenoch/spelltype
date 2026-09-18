/**
 * Game-event reminders: the real service worker, the real permission flow and the
 * real notification ledger, against the real matchmaking boundary.
 *
 * Run on its own against the full Chromium build (the default headless shell
 * cannot deliver notifications):
 *
 *   bun run test:e2e -- tests/e2e/notifications.spec.ts
 *
 * The service-worker opt-in itself comes from the E2E Vite config's `define`
 * (`tests/vite.config.ts` sets VITE_ENABLE_NOTIFICATIONS_SW to '1'); no shell
 * environment is involved.
 *
 * Two environment simulators are used and both are honest about it: page
 * visibility is overridden per context (headless Chromium has no real occlusion),
 * and `Notification.requestPermission` is wrapped with a counter so the spec can
 * prove the app only ever asks inside an explicit click. Everything else — the
 * service worker, its registration, the shown notifications read back through
 * `getNotifications`, the Web Locks ledger — is the production path. What still
 * needs a human: the OS-level toast rendering and a physical click on it.
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

/** Values installed by this spec's browser init scripts. */
type TestGlobals = {
  __setPageVisibility: (value: string) => void;
  __permissionRequests: number;
  __releaseNotificationLock: () => void;
};

/** Headless has no occlusion: the page owns its visibility, like a real user's tab switch. */
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

/** Counts requestPermission calls so the spec can prove mounting never asks. */
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

/** A signed-in context with the visibility and permission instrumentation installed. */
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

/** Enables reminders through the real /me surface; returns once the state line confirms. */
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

/** Every notification the service worker currently holds for this origin. */
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

/** The page's requestPermission counter, installed by PERMISSION_SPY. */
const permissionRequests = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as TestGlobals).__permissionRequests);

/** Queues both players through the UI; returns the room both landed in. */
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

  // Nothing asks by itself: the panel renders, the counter stays at zero.
  await gotoApp(first.page, '/me');
  await expect(first.page.getByTestId('notifications-panel')).toBeVisible();
  await expect(first.page.getByTestId('notifications-enable')).toBeVisible();
  expect(await permissionRequests(first.page)).toBe(0);

  // Permission was pre-granted; the gesture opts in without another browser prompt.
  await first.page.getByTestId('notifications-enable').click();
  await expect(first.page.getByTestId('notifications-state')).toHaveText(ENABLED_STATE);

  // The switch is the user's, not the page instance's: a fresh load keeps it on
  // without spending another request.
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

  // The same lease answered again is the same event: no duplicate toast.
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

  // The page was visible through the whole match: everything a notification would
  // say is already on screen, so none is created.
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

  // The hidden page still lives through generating → countdown exactly once.
  await expect
    .poll(async () => (await shownList(first.page)).map((shown) => shown.title), {
      timeout: 20_000,
    })
    .toContain(COUNTDOWN_TITLE);
  expect(await shownList(first.page)).toHaveLength(1);

  // The rival walks before the fight: the room settles without ever playing. The
  // finished reminder replaces the countdown one (same tag) — still a single toast.
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

  // The player leaves from the (hidden) room surface; the reminder must not
  // outlive the seat it points at.
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

  // Keep the lock in a separate document: navigating the playing page releases
  // all locks that document owns and would erase the intended race window.
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
  // The attempt is stuck behind the lock: nothing shown yet.
  expect(await shownList(first.page)).toHaveLength(0);

  // Signing out invalidates the account's pending attempts…
  await first.page.getByTestId('sign-out').click();
  await expect(first.page.getByTestId('nav-username')).toBeHidden();

  // …so even after the lock frees, the late reminder never arrives.
  await lockPage.evaluate(() => (window as unknown as TestGlobals).__releaseNotificationLock());
  await settle(1500);
  expect(await shownList(first.page)).toHaveLength(0);

  await first.context.close();
  await second.context.close();
});

test('权限被拒或注册失败都不妨碍匹配与输入', async ({ browser }) => {
  // No grant: the explicit click reaches the browser and is refused there.
  const denied = await reminderSession(browser, 'ntf11');
  await gotoApp(denied.page, '/me');
  expect(await permissionRequests(denied.page)).toBe(0);
  await denied.page.getByTestId('notifications-enable').click();
  await expect(denied.page.getByTestId('notifications-state')).toContainText('拒绝');
  expect(await permissionRequests(denied.page)).toBe(1);

  // A broken service worker registration reads as unsupported, not as an error wall.
  const blocked = await reminderSession(browser, 'ntf12', { blockSw: true });
  await gotoApp(blocked.page, '/me');
  await expect(blocked.page.getByTestId('notifications-state')).toContainText('不支持', {
    timeout: 20_000,
  });

  // Both play a full match: matchmaking, the room and typed input are untouched
  // by any of it, and no notification appears on either side.
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
