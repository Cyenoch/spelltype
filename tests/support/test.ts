/**
 * Playwright test object for this suite.
 *
 * Rate limiting needs no per-test handling: the application instance runs with a test-only budget on
 * its isolated runtime, so the suite is not dominated by real budget windows.
 *
 * The auto fixture cancels every tracked matchmaking reservation after each test, so a queued
 * account from one test (including a failing one) can never be matched with a player from the
 * next test.
 */
import { test as base } from '@playwright/test';
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
