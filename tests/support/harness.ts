/**
 * E2E harness: boots the whole native stack in-process and hands the specs real HTTP surfaces.
 *
 * Everything runs locally and in one Bun process: no remote calls, no secrets, no product
 * backdoors.
 *  - the deterministic DeepSeek-compatible fixture (`fixture-server.ts`), which the real AI SDK
 *    reaches through the `GenerateSpells` seam the server composes with;
 *  - the deterministic WeChat bridge (`wechat.ts`), which signs real relay tokens the
 *    server's login verifies;
 *  - one PGlite database opened through the server's own `openDatabase` (migrations included).
 *    The harness owns the handle and passes it into the server instance, so the server and the
 *    specs share one Drizzle instance — tests never reopen the database files;
 *  - the application server: stable API, game paths, admin maintenance surface and `/health`
 *    on one listener, all under the strict same-origin and WeChat-session rules;
 *  - one Vite dev server for the UI. Its `/api` proxy forwards to the application server —
 *    the browser's own origin IS the configured public origin, so the server's real origin
 *    gate stays strict without any fixture-only rewriting.
 *
 * A `restartServer()` stops and re-boots only the application server (same port, same database,
 * same maintenance state — maintenance is durable) — what survives is exactly what the database
 * and the room runtime durably hold.
 *
 * Live data (the PGlite data directory, the Vite cache) lives in a worker- and boot-specific
 * directory beneath the run's state dir, so a crashed worker process — which cannot run a clean
 * `stop()` — leaves its directory claim behind where no replacement worker will ever meet it.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createServer, type ProxyOptions, type ViteDevServer } from 'vite';
import { SESSION_COOKIE, createSession } from '../../server/auth/sessions';
import { openDatabase, type OpenedDatabase } from '../../server/db';
import { accounts } from '../../server/db/schema';
import type { ServerConfig } from '../../server/config';
import { generateSpellSet, type GenerationInput } from '../../server/generation/spells';
import { startServer, type RunningServer } from '../../server/start';
import { startFixtureServer, type FixtureServer } from './fixture-server';
import {
  ADMIN_NICKNAME,
  ADMIN_UNIONID,
  startWechatBridge,
  TEST_WECHAT_BRIDGE,
  WechatIdentity,
  type WechatBridge,
} from './wechat';
import { createFixtureModelFactory } from './test-provider';
import {
  forgetRuntime,
  MIGRATIONS_DIR,
  ROOT,
  RUNTIME_FILE,
  WORKER_STATE_DIR,
  type RuntimeInfo,
} from './runtime';

/** The fixture answers for this key; the product's real key never appears in tests. */
export const TEST_AI_KEY = 'test-fixture-key';
/** Informational build identity the harness compiles into the test server. */
export const TEST_BUILD_ID = 'e2e-harness';

export type RestartOptions = Partial<Pick<ServerConfig, 'inputPolicyMode'>>;

export interface Harness {
  /** The one shared Drizzle instance (PGlite): the server's and the specs' only database. */
  readonly db: OpenedDatabase['db'];
  /** Live address book; also persisted for cross-process readers. */
  info(): RuntimeInfo;
  /** Stops and re-boots the application server on the same port and database. */
  restartServer(options?: RestartOptions): Promise<void>;
  /**
   * Calls the maintenance surface on the public API (`/api/admin/maintenance`) with the harness's
   * admin session cookie — the same surface an admin player's browser drives.
   */
  admin<T>(
    path: string,
    init?: { method?: string; data?: unknown },
  ): Promise<{ status: number; body: T }>;
  /** Pins a WeChat identity on the fixture bridge, e.g. an admin-bound nickname. */
  registerWechatIdentity(identity: WechatIdentity): void;
  readonly wechatBridgeOrigin: string;
  rewriteNextWechatRelay(rewrite: (destination: URL) => void): void;
  stop(): Promise<void>;
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

/** Resolves after `ms`; for races that must not wait forever on a stuck close. */
function after(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitForHttp(url: string, timeoutMs: number, label: string): Promise<void> {
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
    await after(200);
  }
  throw new Error(`${label} at ${url} did not become ready (${lastError})`);
}

/** One Vite dev server for the one UI: shared pipeline, isolated dependency cache. */
async function bootUi(
  port: number,
  proxy: Record<string, ProxyOptions>,
): Promise<{ server: ViteDevServer; origin: string }> {
  // Per-worker, per-run dependency cache. Vite's optimizer keeps one `deps` folder per cacheDir
  // and deletes it wholesale whenever the last writer's config hash differs, so a shared cache
  // thrashes between any two producers (dev builds, the harness) and a crashed optimize leaves
  // the next boot cold. An isolated dir makes this instance's cache its own.
  const cacheDir = path.join(WORKER_STATE_DIR, 'vite-cache', 'app');
  fs.mkdirSync(cacheDir, { recursive: true });
  const server = await createServer({
    configFile: path.join(ROOT, 'tests', 'vite.config.ts'),
    // Native TS config loading, as in scripts/dev.ts: no config bundling step on the boot path.
    configLoader: 'native',
    root: ROOT,
    cacheDir,
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy,
      // E2E observes a stable application; durability scenarios restart servers explicitly.
      hmr: false,
      watch: { ignored: ['**'] },
    },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(`${origin}/`, 30_000, 'UI');
    return { server, origin };
  } catch (error) {
    // Readiness failed after listen: close this instance now, so a failed boot never leaves a
    // listening Vite server (and its bundler threads) behind in a doomed process.
    await Promise.race([server.close(), after(5000)]);
    throw error;
  }
}

let active: Harness | null = null;

/** Boots the harness once per process; later calls return the running instance. */
export async function startHarness(): Promise<Harness> {
  if (active) return active;

  // Live data beneath the worker's own directory: a crashed worker's replacement — same
  // TEST_WORKER_INDEX, new process — boots into a fresh path instead of meeting the dead
  // predecessor's PGlite directory claim.
  const databaseDir = path.join(WORKER_STATE_DIR, 'pglite');
  fs.mkdirSync(databaseDir, { recursive: true });
  const databaseUrl = `pglite://${databaseDir}`;

  const fixture: FixtureServer = await startFixtureServer();
  const bridge: WechatBridge = await startWechatBridge();
  // Holders live outside the boot try-block: a failed boot unwinds exactly what it opened, so a
  // partial start never leaves this process holding the PGlite claim or listening sockets —
  // either would poison every later boot, here and in replacement workers.
  let uiServer: ViteDevServer | null = null;
  let openedDatabase: OpenedDatabase | null = null;
  let primary: RunningServer | null = null;

  const closeBooted = async (): Promise<string[]> => {
    const failures: string[] = [];
    const attempt = async (label: string, step: () => Promise<void>): Promise<void> => {
      try {
        await step();
      } catch (error) {
        failures.push(`${label}: ${String(error)}`);
      }
    };
    if (uiServer !== null) {
      const server = uiServer;
      await attempt('ui', async () => {
        // A page that failed mid-test can leave sockets open; never let teardown hang on them.
        await Promise.race([server.close(), after(5000)]);
      });
    }
    await attempt('server', async () => {
      if (!primary) throw new Error('the application server was never started');
      await Promise.race([primary.close(), after(15_000)]);
    });
    await attempt('bridge', async () => {
      await bridge.close();
    });
    await attempt('fixture', async () => {
      await fixture.close();
    });
    await attempt('database', async () => {
      if (!openedDatabase) throw new Error('database was never opened');
      await openedDatabase.close();
    });
    return failures;
  };

  try {
    // The harness owns the database and passes the handle to the server; closing the server
    // never closes it. The server and the specs therefore see one database.
    const opened = await openDatabase(databaseUrl, {
      migrationsFolder: MIGRATIONS_DIR,
    });
    openedDatabase = opened;
    const { db } = opened;

    const generate = (input: GenerationInput) =>
      generateSpellSet(createFixtureModelFactory(fixture.url), input);

    const apiPort = await freePort();
    const uiPort = await freePort();
    const apiOrigin = `http://127.0.0.1:${apiPort}`;
    // The UI is the canonical public origin: the browser's own Origin header passes the server's
    // strict same-origin gate unmodified, on the page and through the proxy alike.
    const publicOrigin = `http://127.0.0.1:${uiPort}`;

    const proxy: Record<string, ProxyOptions> = {
      '/api': { target: apiOrigin, ws: true },
    };

    let policy: Pick<ServerConfig, 'inputPolicyMode'> = { inputPolicyMode: 'enforce' };

    const makeConfig = (): ServerConfig => ({
      buildId: TEST_BUILD_ID,
      databaseUrl,
      hostname: '127.0.0.1',
      port: apiPort,
      publicOrigin,
      maintenanceToken: null,
      assetsRoot: null,
      // The suite registers many accounts from one local address: a raised attempt budget on a
      // real window, and direct clients that must never be trusted about forwarding.
      authLimits: { attempts: 1000, windowMs: 60_000 },
      trustForwardedFor: false,
      wechatBridge: { ...TEST_WECHAT_BRIDGE, baseUrl: bridge.origin },
      ...policy,
      ai: { apiKey: TEST_AI_KEY, model: 'deepseek-flash' },
    });

    const writeInfo = (): RuntimeInfo => {
      const info: RuntimeInfo = {
        appUrl: publicOrigin,
        apiOrigin,
        fixtureUrl: fixture.origin,
        databaseDir,
      };
      fs.writeFileSync(RUNTIME_FILE, `${JSON.stringify(info, null, 2)}\n`);
      forgetRuntime();
      return info;
    };

    const bootPrimary = (): Promise<RunningServer> =>
      startServer({ config: makeConfig(), generate, database: db });

    primary = await bootPrimary();
    await waitForHttp(new URL('/api/session', apiOrigin).toString(), 60_000, 'application server');
    const bootedUi = await bootUi(uiPort, proxy);
    uiServer = bootedUi.server;

    const restartServer = async (options: RestartOptions = {}): Promise<void> => {
      if (!primary) throw new Error('the application server is not running');
      await primary.close();
      policy = { ...policy, ...options };
      primary = await bootPrimary();
      await waitForHttp(new URL('/api/session', apiOrigin).toString(), 60_000, 'restarted server');
      writeInfo();
    };

    // The maintenance surface lives on the public API and trusts only the server-side account
    // role. The fixture account mirrors what the first real login of the granted UnionID would
    // have created, so `admin()` drives exactly the endpoints an admin player's browser drives.
    let adminCookie: string | null = null;
    const adminSessionCookie = async (): Promise<string> => {
      if (adminCookie) return adminCookie;
      await db
        .insert(accounts)
        .values({
          id: 'e2e-admin-account',
          username: ADMIN_NICKNAME,
          wechat_identity: `union:${ADMIN_UNIONID}`,
          role: 'admin',
          created_at: Date.now(),
        })
        .onConflictDoNothing();
      const ticket = await createSession(db, 'e2e-admin-account');
      adminCookie = ticket.token;
      return adminCookie;
    };

    const admin = async <T>(
      adminPath: string,
      init?: { method?: string; data?: unknown },
    ): Promise<{ status: number; body: T }> => {
      const cookie = await adminSessionCookie();
      const response = await fetch(new URL(adminPath, `${apiOrigin}/`), {
        method: init?.data === undefined ? (init?.method ?? 'GET') : (init?.method ?? 'POST'),
        headers: {
          'content-type': 'application/json',
          origin: publicOrigin,
          cookie: `${SESSION_COOKIE}=${cookie}`,
        },
        body: init?.data === undefined ? undefined : JSON.stringify(init.data),
      });
      const text = await response.text();
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text };
        }
      }
      return { status: response.status, body: body as T };
    };

    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      const failures = await closeBooted();
      if (active === current) active = null;
      if (failures.length > 0) {
        throw new Error(`harness stop left components unclosed: ${failures.join('; ')}`);
      }
    };

    const current: Harness = {
      db,
      info: writeInfo,
      restartServer,
      admin,
      registerWechatIdentity: (identity) => {
        bridge.register(identity);
      },
      wechatBridgeOrigin: bridge.origin,
      rewriteNextWechatRelay: (rewrite) => bridge.rewriteNextRelay(rewrite),
      stop,
    };
    active = current;
    writeInfo();
    return current;
  } catch (bootError) {
    await closeBooted();
    throw bootError;
  }
}

export function harness(): Harness {
  if (!active) throw new Error('the harness is not running; boot it through tests/support/test.ts');
  return active;
}
