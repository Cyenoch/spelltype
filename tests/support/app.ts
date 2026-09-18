/**
 * Browser shell primitives shared by the specs: the app's `data-testid` contract, navigation, the
 * visible error surface and the wall-clock settle used after a write with no observable completion.
 * Everything here reads the same surface a player does. The harness uses `settle` too.
 */
import { expect, type Page } from '@playwright/test';

export async function gotoApp(page: Page, pathname = '/'): Promise<void> {
  await page.goto(pathname, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-root')).toBeVisible();
}

/** Opens the app and waits until the home view is interactive. */
export async function openHome(page: Page): Promise<void> {
  await gotoApp(page);
  await expect(page.getByTestId('view-home')).toBeVisible();
}

/** All error text the player can actually see right now (never console-only). */
export async function visibleErrorText(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const id of [
    'room-error',
    'create-error',
    'auth-error',
    'queue-error',
    'toast',
    'graphics-warning',
  ]) {
    const locator = page.getByTestId(id);
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const element = locator.nth(index);
      if (await element.isVisible()) parts.push(((await element.textContent()) ?? '').trim());
    }
  }
  return parts.filter((part) => part.length > 0).join(' | ');
}

/** Waits for a fixed wall-clock delay (used after a write that has no observable completion). */
export function settle(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
