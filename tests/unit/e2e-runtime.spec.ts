/**
 * The runtime address book is the one cross-process handoff of the E2E harness: each logical run
 * resolves its own state directory, and whatever the harness records there is what a reader in
 * that run observes — never another run's addresses. Release ids are strict UUID32 everywhere.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'bun:test';
import type { RuntimeInfo } from '../support/runtime';

const runtimeUrl = new URL('../support/runtime.ts', import.meta.url).href;

/** Runs a fresh Bun child against the runtime module, so each invocation resolves its own run. */
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
    adminUrl: 'http://127.0.0.1:31003',
    fixtureUrl: 'http://127.0.0.1:31004',
    databaseDir: `${first.stateDir}/pglite`,
    releaseId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    uiUrls: { aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: 'http://127.0.0.1:31001/' },
  };
  const secondInfo: RuntimeInfo = {
    appUrl: 'http://127.0.0.1:32001/',
    apiOrigin: 'http://127.0.0.1:32002',
    adminUrl: 'http://127.0.0.1:32003',
    fixtureUrl: 'http://127.0.0.1:32004',
    databaseDir: `${second.stateDir}/pglite`,
    releaseId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    uiUrls: { bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: 'http://127.0.0.1:32001/' },
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

it('运行信息要求发布标识是 32 位小写十六进制，旧格式一律拒绝', () => {
  const { runId, stateDir, runtimeFile } = JSON.parse(child()) as {
    runId: string;
    stateDir: string;
    runtimeFile: string;
  };
  const info: RuntimeInfo = {
    appUrl: 'http://127.0.0.1:33001/',
    apiOrigin: 'http://127.0.0.1:33002',
    adminUrl: 'http://127.0.0.1:33003',
    fixtureUrl: 'http://127.0.0.1:33004',
    databaseDir: `${stateDir}/pglite`,
    releaseId: 'e2e-a',
    uiUrls: {},
  };
  try {
    recorded(runtimeFile, stateDir, info);
    expect(() => JSON.parse(child(runId, true))).toThrow(/32 hex character release id/);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
