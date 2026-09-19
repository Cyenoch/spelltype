/**
 * 应用边界 E2E 测试套件的 Playwright 配置。
 *
 * 单 worker 使共享的匹配队列、唯一的 PGlite 数据库以及故障注入步骤保持确定性：
 * 多个测试用例共享同一套服务端技术栈（由 worker 作用域的测试环境夹具在进程内启动），
 * 而其中一个用例会改动战绩表。
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
