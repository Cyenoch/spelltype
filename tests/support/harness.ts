/**
 * E2E harness: boots the fixture, migrations and two isolated local application
 * instances (with and without a DeepSeek key), then records their addresses for the
 * specs. Everything runs locally: no remote calls, no secrets, no product backdoors.
 *
 * The auth rate limiter is the real platform binding with the production budget
 * (10 requests / 60s per key per IP) whose state lives inside the application process. The
 * general instances run an isolated runtime with a test-only budget so the suite is not dominated
 * by real budget windows; the dedicated limiter instance keeps the production budget and the one
 * spec that deliberately exhausts it waits for a genuinely fresh window first.
 */
import { Buffer } from 'node:buffer';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { applyMigrations } from './d1';
import { startFixtureServer, type FixtureServer } from './fixture-server';
import { LIMITER_INSTANCE, MIGRATIONS_DIR, ROOT, RUNTIME_FILE, STATE_DIR, type RuntimeInfo } from './runtime';
import { writeInstanceConfig } from './worker-config';

export const TEST_AI_KEY = 'test-fixture-key';
/** Real budget from wrangler.jsonc: 10 auth requests per 60s per key and IP. */
export const AUTH_LIMIT = 10;
/** Test-only budget for the general instances (isolated runtime only). */
const TEST_ONLY_AUTH_LIMIT = 1000;
/** The real limiter window, used by the dedicated limiter instance's spec. */
const AUTH_WINDOW_MS = 60_000;

export type AuthKind = 'register' | 'login';

/** Only the dedicated limiter instance tracks its window, since it keeps the real budget. */
interface AuthWindow {
  startedAt: number;
  used: Record<AuthKind, number>;
}

interface AppInstance {
  name: string;
  port: number;
  url: string;
  configPath: string;
  persistDir: string;
  logFile: string;
  child: ChildProcess;
  window: AuthWindow;
}

export interface Harness {
  info: RuntimeInfo;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  const { promise, resolve } = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => resolve());
  await promise;
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n') : '(no log)';
  throw new Error(`application at ${url} did not become ready (${lastError}).\nLast output:\n${tail}`);
}

function spawnVite(instance: { name: string; root: string; logDir: string; configPath: string; persistDir: string; port: number }): ChildProcess {
  const logFile = path.join(instance.logDir, `${instance.name}.log`);
  const stream = fs.createWriteStream(logFile, { flags: 'a' });
  const viteBin = path.join(instance.root, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) throw new Error(`vite is not installed at ${viteBin}; run the package install first`);
  const child = spawn(process.execPath, [viteBin, '--config', path.join(instance.root, 'tests', 'vite.config.ts')], {
    cwd: instance.root,
    env: {
      ...process.env,
      E2E_WRANGLER_CONFIG: instance.configPath,
      E2E_APP_PORT: String(instance.port),
      E2E_PERSIST_DIR: instance.persistDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(stream);
  child.stderr?.pipe(stream);
  child.on('exit', (code) => stream.write(`\n[vite exited with code ${code}]\n`));
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = Promise.withResolvers<void>();
  child.once('exit', () => exited.resolve());
  child.kill('SIGTERM');
  await Promise.race([exited.promise, new Promise((resolve) => setTimeout(resolve, 4000))]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited.promise, new Promise((resolve) => setTimeout(resolve, 4000))]);
  }
}

async function probeRegistration(url: string, username: string): Promise<{ ok: boolean; status: number; body: string }> {
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
async function ensureSchema(appUrl: string, persistDir: string, migrationsDir: string, probeName: string): Promise<void> {
  let probe = await probeRegistration(appUrl, probeName);
  if (probe.ok || probe.status === 409) return;

  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`no migrations directory at ${migrationsDir}, and the app rejected the schema probe (${probe.status}): ${probe.body}`);
  }
  const { files, applied } = await applyMigrations(persistDir, migrationsDir);
  if (files.length === 0) {
    throw new Error(`schema probe failed (${probe.status} ${probe.body}) and no D1 file was found under ${persistDir}`);
  }
  probe = await probeRegistration(appUrl, `${probeName}b`);
  if (!probe.ok && probe.status !== 409) {
    throw new Error(`schema probe still failing after applying ${applied.length} migrations to ${files.length} file(s): ${probe.status} ${probe.body}`);
  }
}

export async function startHarness(): Promise<Harness> {
  fs.rmSync(STATE_DIR, { recursive: true, force: true });
  const logDir = path.join(STATE_DIR, 'logs');
  const configDir = path.join(STATE_DIR, 'configs');
  const appPersistDir = path.join(STATE_DIR, 'miniflare-app');
  const noKeyPersistDir = path.join(STATE_DIR, 'miniflare-nokey');
  const limiterPersistDir = path.join(STATE_DIR, 'miniflare-limit');
  fs.mkdirSync(logDir, { recursive: true });

  const instances = new Map<string, AppInstance>();

  const boot = async (instance: AppInstance): Promise<void> => {
    instance.child = spawnVite({
      name: instance.name,
      root: ROOT,
      logDir,
      configPath: instance.configPath,
      persistDir: instance.persistDir,
      port: instance.port,
    });
    await waitForHttp(new URL('/api/session', instance.url).toString(), 120_000, instance.logFile);
  };

  const fixture: FixtureServer = await startFixtureServer({
    control: async (controlPath, body) => {
      const payload = (body ?? {}) as { instance?: string; kind?: AuthKind };
      if (controlPath === '/state') {
        return { instances: [...instances.values()].map(({ name, window: current, url }) => ({ name, window: current, url })) };
      }
      if (controlPath === '/restart') {
        // Stops and re-boots one instance on the same port with the same persist directory, so a
        // spec can prove that Durable Object state survives process reactivation.
        const instance = instances.get(payload.instance ?? 'app');
        if (!instance) return { error: `unknown instance ${payload.instance}` };
        await stopChild(instance.child);
        await boot(instance);
        return { restarted: true, url: instance.url };
      }
      if (controlPath === '/fresh-window') {
        const instance = instances.get(payload.instance ?? LIMITER_INSTANCE);
        if (!instance) return { error: `unknown instance ${payload.instance}` };
        const elapsed = Date.now() - instance.window.startedAt;
        if (elapsed < AUTH_WINDOW_MS) await new Promise((resolve) => setTimeout(resolve, AUTH_WINDOW_MS - elapsed + 500));
        instance.window = { startedAt: Date.now(), used: { register: 0, login: 0 } };
        return { window: instance.window };
      }
      return undefined;
    },
  });

  const typesFile = path.join(ROOT, 'worker-configuration.d.ts');
  const typesBackup = fs.existsSync(typesFile) ? fs.readFileSync(typesFile) : null;

  const stop = async () => {
    for (const instance of instances.values()) await stopChild(instance.child);
    await fixture.close();
    if (typesBackup && fs.existsSync(typesFile) && Buffer.compare(fs.readFileSync(typesFile), typesBackup) !== 0) {
      fs.writeFileSync(typesFile, typesBackup);
      console.warn('[e2e] worker-configuration.d.ts was rewritten during the test run and has been restored');
    }
  };

  const start = async (
    name: string,
    options: { vars: Record<string, string>; persistDir: string; limiterLimit?: number },
  ): Promise<AppInstance> => {
    const { configPath } = writeInstanceConfig({
      root: ROOT,
      configDir,
      instance: name,
      vars: { TEST_DEEPSEEK_BASE_URL: fixture.url, ...options.vars },
      limiterLimit: options.limiterLimit,
    });
    const port = await freePort();
    const instance: AppInstance = {
      name,
      port,
      url: `http://127.0.0.1:${port}`,
      configPath,
      persistDir: options.persistDir,
      logFile: path.join(logDir, `${name}.log`),
      child: undefined as unknown as ChildProcess,
      window: { startedAt: Date.now(), used: { register: 0, login: 0 } },
    };
    instances.set(name, instance);
    await boot(instance);
    return instance;
  };

  try {
    const app = await start('app', { vars: { DEEPSEEK_API_KEY: TEST_AI_KEY }, persistDir: appPersistDir, limiterLimit: TEST_ONLY_AUTH_LIMIT });
    const noKey = await start('app-nokey', { vars: {}, persistDir: noKeyPersistDir, limiterLimit: TEST_ONLY_AUTH_LIMIT });
    const limiter = await start(LIMITER_INSTANCE, { vars: {}, persistDir: limiterPersistDir });
    await ensureSchema(app.url, appPersistDir, MIGRATIONS_DIR, `probe${Date.now().toString(36)}`);
    await ensureSchema(noKey.url, noKeyPersistDir, MIGRATIONS_DIR, `probe${Date.now().toString(36)}k`);
    await ensureSchema(limiter.url, limiterPersistDir, MIGRATIONS_DIR, `probe${Date.now().toString(36)}l`);
    await fetch(`${fixture.origin}/__control/reset`, { method: 'POST' });

    const info: RuntimeInfo = {
      appUrl: app.url,
      noKeyAppUrl: noKey.url,
      limitAppUrl: limiter.url,
      fixtureUrl: fixture.origin,
      persistDir: appPersistDir,
      appPersistDir,
      noKeyPersistDir,
      logs: { app: app.logFile, noKeyApp: noKey.logFile, limitApp: limiter.logFile },
      startedAt: Date.now(),
    };
    fs.writeFileSync(RUNTIME_FILE, `${JSON.stringify(info, null, 2)}\n`);
    return { info, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
