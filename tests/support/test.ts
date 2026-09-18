/**
 * Playwright test object for this suite.
 *
 * Rate limiting needs no per-test handling: the general application instances run with a
 * test-only budget on their isolated runtime, while `app-limit` keeps the production budget and
 * is exercised by the dedicated auth-limits spec (which waits for a real fresh window).
 *
 * The auto fixture cancels every tracked matchmaking reservation after each test, so a queued
 * account from one test (including a failing one) can never be matched with a player from the
 * next test.
 */
import { test as base, expect } from '@playwright/test';
import { cleanupTrackedQueues } from './accounts';

export const test = base.extend<{ queueCleanup: void }>({
  queueCleanup: [
    async ({}, use) => {
      await use();
      await cleanupTrackedQueues();
    },
    { auto: true },
  ],
});

export { expect };
export type { Page, BrowserContext, Browser, Locator, APIRequestContext } from '@playwright/test';
export { chromium } from '@playwright/test';
