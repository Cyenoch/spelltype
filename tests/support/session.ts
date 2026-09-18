/**
 * Accounts and the session lifecycle, driven through the real auth view: a fresh isolated browser
 * context per player, registration/sign-in, the signed-out invariant and the account name.
 *
 * Every account created here is registered with the queue-cleanup tracker, so a test that fails
 * halfway cannot leave a matchmaking reservation behind.
 */
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { trackAccountForQueueCleanup } from './accounts';
import { openHome } from './app';
import { runtime } from './runtime';

const PASSWORD = 'spelltype-e2e-pw';
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

export async function signUp(page: Page, username: string, password = PASSWORD): Promise<void> {
  await openAuth(page);
  await page.getByTestId('auth-mode-register').click();
  await page.getByTestId('auth-username').fill(username);
  await page.getByTestId('auth-password').fill(password);
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('nav-username')).toHaveText(username);
  await trackAccountForQueueCleanup(page.context(), new URL(page.url()).origin);
}

export async function signIn(page: Page, username: string, password = PASSWORD): Promise<void> {
  await openAuth(page);
  await page.getByTestId('auth-mode-login').click();
  await page.getByTestId('auth-username').fill(username);
  await page.getByTestId('auth-password').fill(password);
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('nav-username')).toHaveText(username);
  await trackAccountForQueueCleanup(page.context(), new URL(page.url()).origin);
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

/** Registers a fresh account in a fresh context and returns both. */
export async function signedInContext(browser: Browser, prefix = 'p'): Promise<Session> {
  const context = await newContext(browser);
  const page = await context.newPage();
  const username = uniqueName(prefix);
  await openHome(page);
  await signUp(page, username);
  return { context, page, username };
}
