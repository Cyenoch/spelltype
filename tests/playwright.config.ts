/**
 * Playwright configuration for the application-boundary E2E suite.
 *
 * One worker keeps the quick-match Durable Object, the shared fixture queue and the
 * D1 fault-injection steps deterministic: several specs share the one matchmaking queue
 * and one spec mutates the results table.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './global-setup.ts',
  outputDir: './.state/artifacts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: undefined,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: { mode: 'retain-on-failure', screenshots: false },
    screenshot: 'only-on-failure',
  },
});
