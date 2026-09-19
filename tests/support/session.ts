/**
 * 账号与会话生命周期，通过真实的认证视图驱动：
 * 每位玩家拥有全新隔离的浏览器上下文、通过测试桥接进行的微信登录、已登出状态的不变量以及账号名称。
 *
 * 此处创建的每个账号都会向队列清理跟踪器注册，避免测试中途失败遗留匹配预约。
 * 玩家登录时使用的昵称是其稳定的身份：相同的昵称代表相同的微信账号，
 * 因此 `signIn` 会像真实产品的回访老用户一样返回现有账号。
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { trackAccountForQueueCleanup } from './accounts';
import { openHome } from './app';
import { harness } from './harness';
import { runtime } from './runtime';
import { ADMIN_UNIONID, TEST_WECHAT_IDENTITY_COOKIE } from './wechat';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

let accountCounter = 0;

/** 唯一的、字符集安全的账号名称（2–20 字符，ASCII 字母/数字/下划线）。 */
export function uniqueName(prefix = 'p'): string {
  accountCounter += 1;
  return `${prefix}${Date.now().toString(36)}${accountCounter.toString(36)}`.slice(0, 20);
}

export async function newContext(
  browser: Browser,
  options: {
    viewport?: { width: number; height: number };
    reducedMotion?: 'reduce' | 'no-preference';
    baseUrl?: string;
  } = {},
): Promise<BrowserContext> {
  return browser.newContext({
    viewport: options.viewport ?? DESKTOP_VIEWPORT,
    locale: 'zh-CN',
    // 使用产品的静态渲染模式；视觉测试用例可自行开启完整动画。
    reducedMotion: options.reducedMotion ?? 'reduce',
    baseURL: options.baseUrl ?? runtime().appUrl,
  });
}

/** 从应用当前所在页面打开认证视图。 */
export async function openAuth(page: Page): Promise<void> {
  if (await page.getByTestId('view-auth').isVisible()) return;
  const navAuth = page.getByTestId('nav-auth');
  if (await navAuth.isVisible()) await navAuth.click();
  else await page.getByTestId('home-auth').click();
  await expect(page.getByTestId('view-auth')).toBeVisible();
}

/**
 * 作为 `username` 进行一次微信登录：认证视图的真实“微信登录”链接、服务端下发状态 state、
 * 测试桥接重定向以及建立会话的回调。当前 URL 中的邀请信息在跳转往返中得以保留，完全模拟真实的邀请链接。
 */
async function wechatSignIn(page: Page, username: string): Promise<void> {
  await openAuth(page);
  const invite = new URL(page.url()).searchParams.get('room');
  await page.context().addCookies([
    {
      name: TEST_WECHAT_IDENTITY_COOKIE,
      value: encodeURIComponent(username),
      domain: new URL(harness().wechatBridgeOrigin).hostname,
      path: '/api/auth/wechat/bridge/start',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.getByTestId('auth-wechat').click();
  // 回调返回应用根路径（邀请信息保留在 ?room= 中），并已设置会话 Cookie。
  await expect(page.getByTestId('nav-username')).toHaveText(username, { timeout: 30_000 });
  if (invite) {
    await expect(page.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 });
  }
  await trackAccountForQueueCleanup(page.context(), new URL(page.url()).origin);
}

/** 使用绑定到 `username` 的微信身份登录，首次登录时自动创建账号。 */
export async function signUp(page: Page, username: string): Promise<void> {
  await wechatSignIn(page, username);
}

/** 回到测试桥接中为 `username` 保存的账号（相同身份，相同账号）。 */
export async function signIn(page: Page, username: string): Promise<void> {
  await wechatSignIn(page, username);
}

/** 已登出状态的不变量，从持久化的顶部导航栏读取。 */
export async function expectSignedOut(page: Page): Promise<void> {
  await expect(page.getByTestId('nav-username')).toBeHidden();
  await expect(page.getByTestId('sign-out')).toBeHidden();
  await expect(page.getByTestId('nav-auth')).toBeVisible();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByTestId('sign-out').click();
  await expectSignedOut(page);
}

/** 已登录的浏览器会话：包含其上下文、首个页面以及账号名称。 */
export interface Session {
  context: BrowserContext;
  page: Page;
  username: string;
}

/** 在全新上下文中登录一个全新账号并返回两者。 */
export async function signedInContext(browser: Browser, prefix = 'p'): Promise<Session> {
  const context = await newContext(browser);
  const page = await context.newPage();
  const username = uniqueName(prefix);
  await openHome(page);
  await signUp(page, username);
  return { context, page, username };
}

/**
 * 作为管理员登录：该昵称在测试桥接上固定为产品授予管理员角色的唯一 UnionID，
 * 因此该登录会进入真实的 `role: 'admin'` 账号，运维控制台会完全将其视同生产操作员。
 */
export async function adminContext(browser: Browser, prefix = 'admin'): Promise<Session> {
  const username = uniqueName(prefix);
  harness().registerWechatIdentity({
    nickname: username,
    openid: 'open-admin',
    unionid: ADMIN_UNIONID,
  });
  const context = await newContext(browser);
  const page = await context.newPage();
  await openHome(page);
  await signUp(page, username);
  return { context, page, username };
}
