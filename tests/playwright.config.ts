/**
 * Playwright configuration for the application-boundary E2E suite.
 *
 * One worker keeps the quick-match Durable Object, the shared fixture queue and the
 * D1 fault-injection steps deterministic: several specs share the one matchmaking queue
 * and one spec mutates the results table.
 */
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { STATE_DIR } from './support/runtime';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './global-setup.ts',
  outputDir: path.join(STATE_DIR, 'artifacts'),
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
    reducedMotion: 'reduce',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    trace: { mode: 'retain-on-failure', screenshots: false },
    screenshot: 'only-on-failure',
  },
});
