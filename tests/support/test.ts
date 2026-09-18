/**
 * Playwright test object for this suite.
 *
 * The native harness boots lazily in this worker process on first use and stops at worker
 * teardown: fixture, PGlite database, release-A server (role `all`, with admin) and the release-A
 * UI all live here, so specs share the owning server's Drizzle instance directly.
 *
 * The auto fixture also gives every tracked account a clean handover after each test: queue
 * reservations are cancelled, and a started match — which truthfully refuses cancellation — is
 * left through the room's own public leave endpoint, so neither a queued account nor an
 * abandoned active match can leak into the next test in this worker.
 */
import { test as base } from '@playwright/test';
import { cleanupTrackedQueues } from './accounts';
import { startHarness, type Harness } from './harness';

export const test = base.extend<{ queueCleanup: void }, { harness: Harness }>({
  harness: [
    async ({}, use) => {
      // The harness owns the process's PGlite claim and every listening server: if the worker
      // goes away without a clean stop, the database claim outlives it and every replacement
      // worker refuses to boot. stop() therefore runs even when the worker is unwinding.
      const instance = await startHarness();
      try {
        await use(instance);
      } finally {
        await instance.stop();
      }
    },
    { scope: 'worker', auto: true },
  ],
  queueCleanup: [
    async ({}, use) => {
      await use();
      await cleanupTrackedQueues();
    },
    { auto: true },
  ],
});
