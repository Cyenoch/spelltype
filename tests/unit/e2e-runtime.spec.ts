/**
 * 运行时通讯录是端到端测试工具唯一的跨进程交接点：每个逻辑运行都解析各自的状态目录，
 * 并且测试脚手架在该目录记录的内容正是该次运行的读取方所观察到的 —— 决不会串入另一次运行的地址。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'bun:test';
import type { RuntimeInfo } from '../support/runtime';

const runtimeUrl = new URL('../support/runtime.ts', import.meta.url).href;

/** 针对运行时模块启动一个新的 Bun 子进程，确保每次调用都解析其所属的运行。 */
function child(runId?: string, readRuntime = false): string {
  const env = { ...process.env };
  delete env.SPELLTYPE_E2E_RUN_ID;
  if (runId) env.SPELLTYPE_E2E_RUN_ID = runId;
  const script = readRuntime
    ? `import { runtime } from ${JSON.stringify(runtimeUrl)};
       console.log(JSON.stringify(runtime()));`
    : `import { STATE_DIR, RUNTIME_FILE } from ${JSON.stringify(runtimeUrl)};
       console.log(JSON.stringify({ stateDir: STATE_DIR, runtimeFile: RUNTIME_FILE, runId: process.env.SPELLTYPE_E2E_RUN_ID }));`;
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-runtime-'));
  try {
    const file = path.join(dir, 'probe.mts');
    writeFileSync(file, script);
    const result = Bun.spawnSync([process.execPath, file], {
      env,
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function recorded(runtimeFile: string, stateDir: string, info: RuntimeInfo): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(runtimeFile, JSON.stringify(info));
}

it('两个运行各自发布地址，新读取方只读所属运行而不会串到另一应用', () => {
  const first = JSON.parse(child()) as { stateDir: string; runtimeFile: string; runId: string };
  const second = JSON.parse(child()) as typeof first;
  expect(first.stateDir).not.toBe(second.stateDir);
  const firstInfo: RuntimeInfo = {
    appUrl: 'http://127.0.0.1:31001/',
    apiOrigin: 'http://127.0.0.1:31002',
    fixtureUrl: 'http://127.0.0.1:31004',
    databaseDir: `${first.stateDir}/pglite`,
  };
  const secondInfo: RuntimeInfo = {
    appUrl: 'http://127.0.0.1:32001/',
    apiOrigin: 'http://127.0.0.1:32002',
    fixtureUrl: 'http://127.0.0.1:32004',
    databaseDir: `${second.stateDir}/pglite`,
  };
  try {
    recorded(first.runtimeFile, first.stateDir, firstInfo);
    recorded(second.runtimeFile, second.stateDir, secondInfo);
    expect(JSON.parse(child(first.runId, true))).toEqual(firstInfo);
    expect(JSON.parse(child(second.runId, true))).toEqual(secondInfo);
  } finally {
    rmSync(first.stateDir, { recursive: true, force: true });
    rmSync(second.stateDir, { recursive: true, force: true });
  }
});
