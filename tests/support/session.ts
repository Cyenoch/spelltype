/**
 * Accounts and the session lifecycle, driven through the real auth view: a fresh isolated browser
 * context per player, WeChat sign-in through the fixture bridge, the signed-out invariant and the
 * account name.
 *
 * Every account created here is registered with the queue-cleanup tracker, so a test that fails
 * halfway cannot leave a matchmaking reservation behind. The nickname a player signs in with is
 * their stable identity: the same nickname is the same WeChat account, so `signIn` returns to the
 * existing account exactly like the real product's returning user.
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { trackAccountForQueueCleanup } from './accounts';
import { openHome } from './app';
import { harness } from './harness';
import { runtime } from './runtime';
import { ADMIN_UNIONID, TEST_WECHAT_IDENTITY_COOKIE } from './wechat';

const DESKTOP_VIEWPORT = { width: 1440, height: 900 };

let accountCounter = 0;

/** Unique, charset-safe account name (2–20 chars, ASCII letters/digits/underscore). */
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
    // Use the product's static rendering mode; visual scenarios opt into full motion.
    reducedMotion: options.reducedMotion ?? 'reduce',
    baseURL: options.baseUrl ?? runtime().appUrl,
  });
}

/** Opens the auth view from wherever the app currently is. */
export async function openAuth(page: Page): Promise<void> {
  if (await page.getByTestId('view-auth').isVisible()) return;
  const navAuth = page.getByTestId('nav-auth');
  if (await navAuth.isVisible()) await navAuth.click();
  else await page.getByTestId('home-auth').click();
  await expect(page.getByTestId('view-auth')).toBeVisible();
}

/**
 * One WeChat sign-in as `username`: the auth view's real 微信登录 link, the server's state issue,
 * the fixture bridge's redirect and the callback that establishes the session. The invitation in
 * the current URL survives the detour, exactly like a real invite link.
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
  // The callback lands back on the app root (invite preserved as ?room=) with the session set.
  await expect(page.getByTestId('nav-username')).toHaveText(username, { timeout: 30_000 });
  if (invite) {
    await expect(page.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 });
  }
  await trackAccountForQueueCleanup(page.context(), new URL(page.url()).origin);
}

/** Signs in with the WeChat identity bound to `username`, creating the account on first login. */
export async function signUp(page: Page, username: string): Promise<void> {
  await wechatSignIn(page, username);
}

/** Returns to the account the fixture bridge holds for `username` (same identity, same account). */
export async function signIn(page: Page, username: string): Promise<void> {
  await wechatSignIn(page, username);
}

/** The signed-out invariant, read from the persistent topbar. */
export async function expectSignedOut(page: Page): Promise<void> {
  await expect(page.getByTestId('nav-username')).toBeHidden();
  await expect(page.getByTestId('sign-out')).toBeHidden();
  await expect(page.getByTestId('nav-auth')).toBeVisible();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByTestId('sign-out').click();
  await expectSignedOut(page);
}

/** A signed-in browser session: its context, its first page and the account name. */
export interface Session {
  context: BrowserContext;
  page: Page;
  username: string;
}

/** Signs a fresh account in inside a fresh context and returns both. */
export async function signedInContext(browser: Browser, prefix = 'p'): Promise<Session> {
  const context = await newContext(browser);
  const page = await context.newPage();
  const username = uniqueName(prefix);
  await openHome(page);
  await signUp(page, username);
  return { context, page, username };
}

/**
 * Signs in as an administrator: the nickname is pinned on the fixture bridge to the one UnionID
 * the product grants the admin role, so this login lands on a real `role: 'admin'` account and
 * the maintenance console treats it exactly like the production operator.
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
