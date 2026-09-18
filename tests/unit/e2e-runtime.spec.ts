import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import type { RuntimeInfo } from '../support/runtime';

const runtimeUrl = new URL('../support/runtime.ts', import.meta.url).href;

function child(runId?: string, readRuntime = false): string {
  const env = { ...process.env };
  delete env.SPELLTYPE_E2E_RUN_ID;
  if (runId) env.SPELLTYPE_E2E_RUN_ID = runId;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { STATE_DIR, RUNTIME_FILE, runtime } from ${JSON.stringify(runtimeUrl)};
       console.log(JSON.stringify(${readRuntime ? 'runtime()' : '{ stateDir: STATE_DIR, runtimeFile: RUNTIME_FILE, runId: process.env.SPELLTYPE_E2E_RUN_ID }'}));`,
    ],
    {
      env,
      encoding: 'utf8',
      timeout: 10_000,
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

it('两个运行各自发布地址，新 worker 只读所属运行而不会串到另一应用', () => {
  const first = JSON.parse(child()) as { stateDir: string; runtimeFile: string; runId: string };
  const second = JSON.parse(child()) as typeof first;
  expect(first.stateDir).not.toBe(second.stateDir);
  const firstInfo: RuntimeInfo = {
    appUrl: 'http://127.0.0.1:31001',
    fixtureUrl: 'http://127.0.0.1:31002',
    persistDir: first.stateDir,
  };
  const secondInfo: RuntimeInfo = {
    appUrl: 'http://127.0.0.1:32001',
    fixtureUrl: 'http://127.0.0.1:32002',
    persistDir: second.stateDir,
  };
  try {
    fs.mkdirSync(first.stateDir, { recursive: true });
    fs.writeFileSync(first.runtimeFile, JSON.stringify(firstInfo));
    fs.mkdirSync(second.stateDir, { recursive: true });
    fs.writeFileSync(second.runtimeFile, JSON.stringify(secondInfo));
    expect(JSON.parse(child(first.runId, true))).toEqual(firstInfo);
    expect(JSON.parse(child(second.runId, true))).toEqual(secondInfo);
  } finally {
    fs.rmSync(first.stateDir, { recursive: true, force: true });
    fs.rmSync(second.stateDir, { recursive: true, force: true });
  }
});
