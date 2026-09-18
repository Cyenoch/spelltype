/**
 * E2E harness: boots the whole native stack in-process and hands the specs real HTTP surfaces.
 *
 * Everything runs locally and in one Bun process: no remote calls, no secrets, no product
 * backdoors.
 *  - the deterministic DeepSeek-compatible fixture (`fixture-server.ts`), which the real AI SDK
 *    reaches through the `GenerateSpells` seam the server composes with;
 *  - one PGlite database opened through the server's own `openDatabase` (migrations included).
 *    The harness owns the handle and passes it into every server instance, so both the servers
 *    and the specs share one Drizzle instance — tests never reopen the database files;
 *  - the primary server (release A, role `all`): stable API + game API + admin listener;
 *  - on demand a second, genuinely simultaneous server for the staged release (role `game`, which
 *    never autoactivates) — the A/B release scenario drives stage/check/activate through the real
 *    admin API while A keeps serving;
 *  - one Vite dev server per release identity, so pages compiled with release A's constant and
 *    pages compiled with release B's constant exist side by side, exactly like old and new
 *    clients in a real deploy window. Each instance gets its own dependency-optimizer cache
 *    (Vite keeps one `deps` folder per cacheDir and deletes it on any config-hash change, so
 *    instances sharing `node_modules/.vite` would wipe each other's committed caches);
 *
 * A `restartServer()` stops and re-boots only the primary server (same port, same database) —
 * what survives is exactly what the database and the room runtime durably hold.
 *
 * Live data (the PGlite data directory, the Vite caches) lives in a worker- and boot-specific
 * directory beneath the run's state dir, so a crashed worker process — which cannot run a clean
 * `stop()` — leaves its directory claim behind where no replacement worker will ever meet it.
 *
 * Fixture-only address mapping: the stable API validates Origin against its canonical public
 * origin (the primary UI). Every UI instance's `/api` proxy translates an Origin exactly equal
 * to that instance's own origin into the canonical one; all other origins pass untouched and
 * the release-scoped game proxies are never rewritten. The server's real origin gate stays
 * strict.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { ClientRequest } from 'node:http';
import { createServer, type ProxyOptions, type ViteDevServer } from 'vite';
import { gameApiBase } from '../../shared/release';
import { openDatabase, type Database, type OpenedDatabase } from '../../server/db';
import type { ServerConfig } from '../../server/config';
import type { ReleaseProbe } from '../../server/contracts';
import { generateSpellSet, type GenerationInput } from '../../server/generation/spells';
import { startServer, type RunningServer } from '../../server/start';
import { startFixtureServer, type FixtureServer } from './fixture-server';
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
/**
 * Fixed release-admin credential for the isolated instance (64 lowercase hex chars, as the admin
 * route's token format demands). The release scenario uses the same constant against the real
 * admin API.
 */
export const TEST_RELEASE_ADMIN_TOKEN =
  '3f9a1c7e5b2d84f06a4d8c2e91b7f35a6d0c8e42b19f7a53c6e2d94b80175fac';
/** The release id the harness opens with; the A/B scenario stages, checks and activates B. */
export const TEST_RELEASE_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** The staged candidate release: booted as a real game runtime, never autoactivating. */
export const TEST_RELEASE_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

export type RestartOptions = Partial<Pick<ServerConfig, 'inputPolicyMode' | 'matchAdmission'>>;

export interface Harness {
  /** The one shared Drizzle instance (PGlite): the servers' and the specs' only database. */
  readonly db: Database;
  /** Live address book; also persisted for cross-process readers. */
  info(): RuntimeInfo;
  /** Stops and re-boots the primary server on the same port and database. */
  restartServer(options?: RestartOptions): Promise<void>;
  /** Boots the staged release's game server plus its UI; idempotent; never activates anything. */
  startReleaseServer(releaseId: string): Promise<string>;
  /** Points new browser contexts and direct API calls at the given release's UI. */
  useRelease(releaseId: string): Promise<void>;
  /** Calls the primary server's real admin API with the harness's fixed bearer token. */
  admin<T>(
    path: string,
    init?: { method?: string; data?: unknown },
  ): Promise<{ status: number; body: T }>;
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

/** One Vite dev server per release identity: the UI pipeline is shared, the constant is not. */
async function bootUi(
  releaseId: string,
  port: number,
  proxy: Record<string, ProxyOptions>,
): Promise<{ server: ViteDevServer; origin: string }> {
  // Per-worker, per-run, per-release dependency cache. Vite's optimizer keeps one `deps` folder
  // per cacheDir and deletes it wholesale whenever the last writer's config hash differs, so a
  // shared cache thrashes between any two producers (dev builds, release A, release B) and a
  // crashed optimize leaves the next boot cold. Isolated dirs make every instance's cache its
  // own; each run pays one cold optimize per release before the first navigation.
  const cacheDir = path.join(WORKER_STATE_DIR, 'vite-cache', releaseId);
  fs.mkdirSync(cacheDir, { recursive: true });
  const server = await createServer({
    configFile: path.join(ROOT, 'tests', 'vite.config.ts'),
    // Native TS config loading, as in scripts/dev.ts: no config bundling step on the boot path.
    configLoader: 'native',
    root: ROOT,
    // Per-instance identity; the config file carries only the shared pipeline.
    define: { __SPELLTYPE_RELEASE_ID__: JSON.stringify(releaseId) },
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
    await waitForHttp(`${origin}/`, 30_000, `UI for release ${releaseId}`);
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
  // Holders live outside the boot try-block: a failed boot unwinds exactly what it opened, so a
  // partial start never leaves this process holding the PGlite claim or listening sockets —
  // either would poison every later boot, here and in replacement workers.
  const uiUrls: Record<string, string> = {};
  const uiServers: Record<string, ViteDevServer> = {};
  let openedDatabase: OpenedDatabase | null = null;
  let primary: RunningServer | null = null;
  let gameB: RunningServer | null = null;

  const closeUi = async (server: ViteDevServer): Promise<void> => {
    // A page that failed mid-test can leave sockets open; never let teardown hang on them.
    await Promise.race([server.close(), after(5000)]);
  };

  /** Best-effort, stage by stage: one stuck component must never skip the PGlite claim release. */
  const closeBooted = async (): Promise<string[]> => {
    const failures: string[] = [];
    const attempt = async (label: string, step: () => Promise<void>): Promise<void> => {
      try {
        await step();
      } catch (error) {
        failures.push(`${label}: ${String(error)}`);
      }
    };
    for (const [releaseId, server] of Object.entries(uiServers)) {
      await attempt(`ui(${releaseId})`, async () => {
        await closeUi(server);
      });
    }
    await attempt('servers', async () => {
      await Promise.race([Promise.all([gameB?.close(), primary?.close()]), after(15_000)]);
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
    // The harness owns the database and passes the handle to every server; closing a server never
    // closes it. Both simultaneous releases therefore see one database, and so do the specs.
    const opened = await openDatabase(databaseUrl, {
      migrationsFolder: MIGRATIONS_DIR,
    });
    openedDatabase = opened;
    const { db } = opened;

    const generate = (input: GenerationInput) =>
      generateSpellSet(createFixtureModelFactory(fixture.url), input);

    const apiPort = await freePort();
    const apiAdminPort = await freePort();
    const gameBPort = await freePort();
    const uiAPort = await freePort();
    const uiBPort = await freePort();
    const apiOrigin = `http://127.0.0.1:${apiPort}`;
    const gameBOrigin = `http://127.0.0.1:${gameBPort}`;
    const uiAOrigin = `http://127.0.0.1:${uiAPort}`;
    const uiBOrigin = `http://127.0.0.1:${uiBPort}`;

    // Proxy targets are predeclared before either UI boots: the release-B target points at the port
    // its server will take later, so booting B never rewrites (and never restarts) a running UI.
    const gameTargetByRelease: Record<string, string> = {
      [TEST_RELEASE_A]: apiOrigin,
      [TEST_RELEASE_B]: gameBOrigin,
    };

    /**
     * Each UI instance proxies to the same servers, but the stable API checks Origin against
     * its canonical public origin (the primary UI). This fixture-only mapping translates an
     * Origin exactly equal to the proxying UI's own origin into that canonical origin, so both
     * UI origins can drive the stable API without relaxing the server's real origin gate —
     * missing, foreign or wrong-scheme origins pass untouched, and the release-scoped game
     * proxies (which each own their release's origin) are never rewritten.
     */
    const uiProxies = (ownOrigin: string): Record<string, ProxyOptions> => {
      const proxy: Record<string, ProxyOptions> = {};
      for (const [releaseId, target] of Object.entries(gameTargetByRelease)) {
        proxy[`/api/releases/${releaseId}`] = { target, ws: true };
      }
      const translateOrigin = (proxyRequest: ClientRequest): void => {
        const origin = proxyRequest.getHeader('origin');
        if (typeof origin === 'string' && origin === ownOrigin) {
          proxyRequest.setHeader('origin', uiAOrigin);
        }
      };
      proxy['/api'] = {
        target: apiOrigin,
        ws: true,
        configure: (upstream) => {
          upstream.on('proxyReq', (proxyRequest) => {
            translateOrigin(proxyRequest);
          });
          upstream.on('proxyReqWs', (proxyRequest) => {
            translateOrigin(proxyRequest);
          });
        },
      };
      return proxy;
    };

    let policy: Pick<ServerConfig, 'inputPolicyMode' | 'matchAdmission'> = {
      inputPolicyMode: 'enforce',
      matchAdmission: 'open',
    };

    const makeConfig = (
      role: ServerConfig['role'],
      releaseId: string,
      port: number,
      adminPort: number | null,
      publicOrigin: string,
    ): ServerConfig => ({
      role,
      releaseId,
      databaseUrl,
      hostname: '127.0.0.1',
      port,
      adminPort,
      publicOrigin,
      adminToken: TEST_RELEASE_ADMIN_TOKEN,
      assetsRoot: null,
      // The suite registers many accounts from one local address: a raised attempt budget on a
      // real window, and direct clients that must never be trusted about forwarding.
      authLimits: { attempts: 1000, windowMs: 60_000 },
      trustForwardedFor: false,
      ...policy,
      ai: { apiKey: TEST_AI_KEY, model: 'deepseek-flash' },
    });

    let defaultRelease = TEST_RELEASE_A;

    const writeInfo = (): RuntimeInfo => {
      const info: RuntimeInfo = {
        appUrl: uiUrls[defaultRelease] ?? Object.values(uiUrls)[0],
        apiOrigin,
        adminUrl: `http://127.0.0.1:${apiAdminPort}`,
        fixtureUrl: fixture.origin,
        databaseDir,
        releaseId: defaultRelease,
        uiUrls: { ...uiUrls },
      };
      fs.writeFileSync(RUNTIME_FILE, `${JSON.stringify(info, null, 2)}\n`);
      forgetRuntime();
      return info;
    };

    // The staged release's health is probed over real HTTP by the admin check — the harness injects
    // only the address resolution (production derives game-<releaseId>:3000 from compose naming).
    const releaseProbe: ReleaseProbe = async (releaseId) => {
      if (releaseId !== TEST_RELEASE_B || !gameB) {
        throw new Error(`no live game runtime is booted for release ${releaseId}`);
      }
      const response = await fetch(new URL(`${gameApiBase(releaseId)}/health`, gameB.url), {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`game health probe for ${releaseId} returned ${response.status}`);
      }
      const body = (await response.json()) as { releaseId?: string; runtimeEpoch?: number };
      if (typeof body.releaseId !== 'string' || typeof body.runtimeEpoch !== 'number') {
        throw new Error(`game health probe for ${releaseId} returned an unusable body`);
      }
      return { releaseId: body.releaseId, runtimeEpoch: body.runtimeEpoch };
    };

    const bootPrimary = (): Promise<RunningServer> =>
      startServer({
        config: makeConfig('all', TEST_RELEASE_A, apiPort, apiAdminPort, uiAOrigin),
        generate,
        database: db,
        releaseProbe,
      });

    primary = await bootPrimary();
    await waitForHttp(new URL('/api/session', apiOrigin).toString(), 60_000, 'primary server');
    const bootedUiA = await bootUi(TEST_RELEASE_A, uiAPort, uiProxies(uiAOrigin));
    uiServers[TEST_RELEASE_A] = bootedUiA.server;
    uiUrls[TEST_RELEASE_A] = bootedUiA.origin;

    const restartServer = async (options: RestartOptions = {}): Promise<void> => {
      if (!primary) throw new Error('the primary server is not running');
      await primary.close();
      policy = { ...policy, ...options };
      primary = await bootPrimary();
      await waitForHttp(new URL('/api/session', apiOrigin).toString(), 60_000, 'restarted server');
      writeInfo();
    };

    const startReleaseServer = async (releaseId: string): Promise<string> => {
      if (releaseId !== TEST_RELEASE_B) {
        throw new Error(`the harness only stages release ${TEST_RELEASE_B} on demand`);
      }
      if (gameB) return uiUrls[releaseId];
      gameB = await startServer({
        config: makeConfig('game', releaseId, gameBPort, null, uiBOrigin),
        generate,
        database: db,
      });
      await waitForHttp(
        new URL(`${gameApiBase(releaseId)}/health`, gameB.url).toString(),
        60_000,
        `staged game server for ${releaseId}`,
      );
      const booted = await bootUi(releaseId, uiBPort, uiProxies(uiBOrigin));
      uiServers[releaseId] = booted.server;
      uiUrls[releaseId] = booted.origin;
      writeInfo();
      return uiUrls[releaseId];
    };

    const useRelease = async (releaseId: string): Promise<void> => {
      if (!uiUrls[releaseId]) throw new Error(`no UI was booted for release ${releaseId}`);
      defaultRelease = releaseId;
      writeInfo();
    };

    const admin = async <T>(
      adminPath: string,
      init?: { method?: string; data?: unknown },
    ): Promise<{ status: number; body: T }> => {
      const response = await fetch(
        new URL(`/release${adminPath}`, `http://127.0.0.1:${apiAdminPort}`),
        {
          method: init?.data === undefined ? (init?.method ?? 'GET') : (init?.method ?? 'POST'),
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${TEST_RELEASE_ADMIN_TOKEN}`,
          },
          body: init?.data === undefined ? undefined : JSON.stringify(init.data),
        },
      );
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
      startReleaseServer,
      useRelease,
      admin,
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
