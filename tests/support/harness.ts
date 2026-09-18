/**
 * E2E harness: boots the fixture plus one isolated local application instance, applies the D1
 * schema, and records the address for the specs. Everything runs locally: no remote calls, no
 * secrets, no product backdoors.
 *
 * One instance covers every retained scenario. The DeepSeek key is always present (the fixture
 * answers for it), and the auth rate limiter runs with a test-only budget on this isolated runtime
 * because the suite registers several accounts from one IP: the generated per-instance config is
 * the only place that budget differs, and the product's wrangler config is never modified.
 */
import { Buffer } from 'node:buffer';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { settle } from './app';
import { applyMigrations } from './d1';
import { startFixtureServer, type FixtureServer } from './fixture-server';
import { MIGRATIONS_DIR, ROOT, RUNTIME_FILE, STATE_DIR, type RuntimeInfo } from './runtime';
import { writeInstanceConfig } from './worker-config';

export const TEST_AI_KEY = 'test-fixture-key';
/** Test-only budget for this isolated runtime (the product's own config keeps 10/60s). */
const TEST_ONLY_AUTH_LIMIT = 1000;

/** Where an instance lives. Stable across a restart, so the harness can keep its port and persist dir. */
interface AppAddress {
  name: string;
  port: number;
  url: string;
  configPath: string;
  persistDir: string;
  logFile: string;
}

interface AppInstance extends AppAddress {
  child: ChildProcess;
}

export interface Harness {
  info: RuntimeInfo;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const port = (server.address() as net.AddressInfo).port;
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  return port;
}

async function waitForHttp(url: string, timeoutMs: number, logFile: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.status < 500) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = (error as Error).message;
    }
    await settle(400);
  }
  const tail = fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n')
    : '(no log)';
  throw new Error(
    `application at ${url} did not become ready (${lastError}).\nLast output:\n${tail}`,
  );
}

function spawnVite(instance: {
  name: string;
  root: string;
  logDir: string;
  configPath: string;
  persistDir: string;
  port: number;
}): ChildProcess {
  const logFile = path.join(instance.logDir, `${instance.name}.log`);
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  const viteBin = path.join(instance.root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin))
    throw new Error(`vite is not installed at ${viteBin}; run the package install first`);
  const child = spawn(
    process.execPath,
    [viteBin, '--config', path.join(instance.root, 'tests', 'vite.config.ts')],
    {
      cwd: instance.root,
      env: {
        ...process.env,
        E2E_WRANGLER_CONFIG: instance.configPath,
        E2E_APP_PORT: String(instance.port),
        E2E_PERSIST_DIR: instance.persistDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.pipe(stream);
  child.stderr?.pipe(stream);
  child.on('exit', (code) => stream.write(`\n[vite exited with code ${code}]\n`));
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = Promise.withResolvers<void>();
  const onExit = () => exited.resolve();
  const controller = new AbortController();
  child.once('exit', onExit);
  try {
    child.kill('SIGTERM');
    await Promise.race([
      exited.promise,
      delay(4000, undefined, { signal: controller.signal, ref: false }),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await Promise.race([
        exited.promise,
        delay(4000, undefined, { signal: controller.signal, ref: false }),
      ]);
    }
  } finally {
    controller.abort();
    child.off('exit', onExit);
  }
}

async function probeRegistration(
  url: string,
  username: string,
): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetch(new URL('/api/register', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(url).origin },
    body: JSON.stringify({ username, password: 'harness-probe-pw-1234' }),
  });
  return { ok: response.ok, status: response.status, body: await response.text() };
}

/**
 * Boots the app, then guarantees the isolated D1 file is migrated. The first request
 * creates the D1 file; migrations are applied to whatever local D1 files exist, which
 * keeps the harness independent of wrangler's local file naming.
 */
async function ensureSchema(
  appUrl: string,
  persistDir: string,
  migrationsDir: string,
  probeName: string,
): Promise<void> {
  let probe = await probeRegistration(appUrl, probeName);
  if (probe.ok || probe.status === 409) return;

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(
      `no migrations directory at ${migrationsDir}, and the app rejected the schema probe (${probe.status}): ${probe.body}`,
    );
  }
  const { files, applied } = applyMigrations(persistDir, migrationsDir);
  if (files.length === 0) {
    throw new Error(
      `schema probe failed (${probe.status} ${probe.body}) and no D1 file was found under ${persistDir}`,
    );
  }
  probe = await probeRegistration(appUrl, `${probeName}b`);
  if (!probe.ok && probe.status !== 409) {
    throw new Error(
      `schema probe still failing after applying ${applied.length} migrations to ${files.length} file(s): ${probe.status} ${probe.body}`,
    );
  }
}

export async function startHarness(): Promise<Harness> {
  const logDir = path.join(STATE_DIR, 'logs');
  const configDir = path.join(STATE_DIR, 'configs');
  const persistDir = path.join(STATE_DIR, 'miniflare-app');
  fs.mkdirSync(logDir, { recursive: true });

  // Assigned before the fixture is reachable from a spec; the control closure only runs mid-run,
  // so it can safely read the current instance.
  let instance: AppInstance | null = null;

  // Stops and re-boots the instance on the same address, so a spec can prove that Durable Object
  // state survives process reactivation. The optional overrides patch ONLY this instance's
  // generated config vars for the next boot; anything unexpected is a spec bug and fails loudly
  // instead of booting an instance under a misunderstood policy.
  const restart = async (
    overrides: { inputPolicyMode?: string; matchAdmission?: string } = {},
  ): Promise<{ restarted: boolean; url: string } | undefined> => {
    if (!instance) return undefined;
    if (
      overrides.inputPolicyMode !== undefined &&
      overrides.inputPolicyMode !== 'observe' &&
      overrides.inputPolicyMode !== 'enforce'
    )
      throw new Error(`restart: unsupported inputPolicyMode ${overrides.inputPolicyMode}`);
    if (
      overrides.matchAdmission !== undefined &&
      overrides.matchAdmission !== 'open' &&
      overrides.matchAdmission !== 'draining'
    )
      throw new Error(`restart: unsupported matchAdmission ${overrides.matchAdmission}`);
    await stopChild(instance.child);
    if (overrides.inputPolicyMode !== undefined || overrides.matchAdmission !== undefined) {
      const raw = JSON.parse(fs.readFileSync(instance.configPath, 'utf8')) as {
        vars?: Record<string, unknown>;
      };
      raw.vars ??= {};
      if (overrides.inputPolicyMode !== undefined)
        raw.vars.INPUT_POLICY_MODE = overrides.inputPolicyMode;
      if (overrides.matchAdmission !== undefined)
        raw.vars.MATCH_ADMISSION = overrides.matchAdmission;
      fs.writeFileSync(instance.configPath, `${JSON.stringify(raw, null, 2)}\n`);
    }
    instance = await boot(instance);
    return { restarted: true, url: instance.url };
  };

  const boot = async (address: AppAddress): Promise<AppInstance> => {
    const child = spawnVite({
      name: address.name,
      root: ROOT,
      logDir,
      configPath: address.configPath,
      persistDir: address.persistDir,
      port: address.port,
    });
    try {
      await waitForHttp(new URL('/api/session', address.url).toString(), 120_000, address.logFile);
    } catch (error) {
      await stopChild(child);
      throw error;
    }
    return { ...address, child };
  };

  const fixture: FixtureServer = await startFixtureServer({
    control: async (controlPath, body) =>
      controlPath === '/restart'
        ? restart(typeof body === 'object' && body !== null ? body : {})
        : undefined,
  });

  const typesFile = path.join(ROOT, 'worker-configuration.d.ts');
  const typesBackup = fs.existsSync(typesFile) ? fs.readFileSync(typesFile) : null;

  const stop = async () => {
    if (instance) await stopChild(instance.child);
    await fixture.close();
    if (
      typesBackup &&
      fs.existsSync(typesFile) &&
      Buffer.compare(fs.readFileSync(typesFile), typesBackup) !== 0
    ) {
      fs.writeFileSync(typesFile, typesBackup);
      console.warn(
        '[e2e] worker-configuration.d.ts was rewritten during the test run and has been restored',
      );
    }
  };

  try {
    const { configPath } = writeInstanceConfig({
      root: ROOT,
      configDir,
      instance: 'app',
      vars: {
        TEST_DEEPSEEK_BASE_URL: fixture.url,
        DEEPSEEK_API_KEY: TEST_AI_KEY,
        // The suite's default rules: admissions open, the input gate enforcing. Specs that need
        // the other value switch it through restartInstance({ ... }) on the isolated config only.
        MATCH_ADMISSION: 'open',
        INPUT_POLICY_MODE: 'enforce',
      },
      limiterLimit: TEST_ONLY_AUTH_LIMIT,
    });
    const port = await freePort();
    instance = await boot({
      name: 'app',
      port,
      url: `http://127.0.0.1:${port}`,
      configPath,
      persistDir,
      logFile: path.join(logDir, 'app.log'),
    });
    await ensureSchema(instance.url, persistDir, MIGRATIONS_DIR, `probe${Date.now().toString(36)}`);
    await fetch(`${fixture.origin}/__control/reset`, { method: 'POST' });

    const info: RuntimeInfo = {
      appUrl: instance.url,
      fixtureUrl: fixture.origin,
      persistDir,
    };
    fs.writeFileSync(RUNTIME_FILE, `${JSON.stringify(info, null, 2)}\n`);
    return { info, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
