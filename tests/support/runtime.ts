/**
 * E2E 测试环境与各测试用例共享的运行时契约。
 *
 * 测试环境在进程内启动技术栈的每个部分 —— 夹具、PGlite 数据库、
 * 原生服务端（稳定 API、游戏路径与管理路径共用一个监听器）、
 * 微信桥接夹具以及 Vite UI 服务端 —— 并在此发布一份地址簿。
 * 地址簿是唯一跨进程存续的基于文件的交接物（单元测试会针对它派生子进程），
 * 而实时控制项（重启、共享数据库句柄、维护管理端）则位于
 * `harness.ts` 中的测试环境单例上。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FixtureGeneration } from './fixture-generation';
import type { FixtureRequestLog, FixtureState } from './fixture-server';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runId = (process.env.SPELLTYPE_E2E_RUN_ID ??= randomUUID());
export const STATE_DIR = path.join(ROOT, 'tests', '.state', runId);
export const RUNTIME_FILE = path.join(STATE_DIR, 'runtime.json');
/**
 * 每次启动的实时数据（PGlite 数据目录、Vite 依赖缓存）位于本次运行的
 * 状态目录之下、一个与 worker 和本次启动都相关的目录中。
 * 接替的 worker —— Playwright 会在回收复用的 worker 进程间复用 `TEST_WORKER_INDEX` ——
 * 会得到全新的路径，因此它绝不会撞上崩溃前驱的 PGlite 目录占用声明，
 * 两个 worker 也绝不会共享实时文件。该后缀按进程生成，
 * 绝不取自上一次启动触碰过的数据；陈旧的占用声明绝不被删除或窃取。
 * 只有 RUNTIME_FILE 仍是运行 id 的纯函数：它是跨进程地址簿，
 * 读取方仅凭运行 id 即可重新推导出它。
 */
const workerKey =
  process.env.TEST_WORKER_INDEX === undefined
    ? `standalone-${randomUUID().slice(0, 8)}`
    : `worker-${process.env.TEST_WORKER_INDEX}-${randomUUID().slice(0, 8)}`;
export const WORKER_STATE_DIR = path.join(STATE_DIR, workerKey);
/** 仓库的 drizzle 迁移目录，测试环境将其传给 `openDatabase`。 */
export const MIGRATIONS_DIR = path.join(ROOT, 'drizzle');

export interface RuntimeInfo {
  /** UI 源（测试环境启动的唯一一个 Vite 服务端）。 */
  appUrl: string;
  /** 应用服务端：稳定 API、游戏路径、管理界面与 `/health` 共用一个监听器。 */
  apiOrigin: string;
  /** 夹具源；生成请求由 `${fixtureUrl}/v1` 提供。 */
  fixtureUrl: string;
  /** PGlite 数据目录。由测试环境持有；测试用例绝不直接打开这些文件。 */
  databaseDir: string;
}

let cached: RuntimeInfo | null = null;

export function runtime(): RuntimeInfo {
  if (cached) return cached;
  if (!fs.existsSync(RUNTIME_FILE)) {
    throw new Error(
      `E2E runtime file ${RUNTIME_FILE} is missing; the harness boots in-process with the tests, so a missing file means the suite bypassed tests/support/test.ts`,
    );
  }
  cached = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) as RuntimeInfo;
  return cached;
}

/** 测试环境的缓存失效标记：它在每次启动时重写该文件。 */
export function forgetRuntime(): void {
  cached = null;
}

/**
 * 房间所接受的那次生成，以及产生它的请求：
 * 请求携带产品自身提示词所要求的长度区间，载荷则是房间实际提供的咒文书。
 */
export function acceptedGeneration(state: FixtureState): {
  request: FixtureRequestLog;
  generation: FixtureGeneration;
} {
  const request = state.requests.at(-1);
  if (!request) throw new Error('no generation request in the fixture log');
  const generation = state.generations.find((entry) => entry.index === request.generationIndex);
  if (!generation)
    throw new Error(`generation ${request.generationIndex} missing from the fixture log`);
  return { request, generation };
}

export interface FixtureClient {
  state(): Promise<FixtureState>;
  reset(): Promise<void>;
  setDelay(milliseconds: number): Promise<void>;
}

async function control<T>(fixtureUrl: string, pathname: string, body?: unknown): Promise<T> {
  const response = await fetch(`${fixtureUrl}/__control${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok)
    throw new Error(
      `fixture control ${pathname} failed: ${response.status} ${await response.text()}`,
    );
  return (await response.json()) as T;
}

export function fixture(): FixtureClient {
  const base = runtime().fixtureUrl;
  return {
    state: async () => {
      const response = await fetch(`${base}/__control/state`);
      if (!response.ok) throw new Error(`fixture state failed: ${response.status}`);
      return (await response.json()) as FixtureState;
    },
    reset: async () => {
      await control(base, '/reset');
    },
    setDelay: async (milliseconds) => {
      await control(base, '/delay', milliseconds);
    },
  };
}
