/**
 * Playwright configuration for the application-boundary E2E suite.
 *
 * One worker keeps the shared matchmaking queue, the one PGlite database and the fault-injection
 * steps deterministic: several specs share the one server stack (booted in-process by the
 * worker-scoped harness fixture) and one spec mutates the results table.
 */
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { STATE_DIR } from './support/runtime';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
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
