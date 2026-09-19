/**
 * E2E 测试环境：在进程内启动整套原生技术栈，并向各测试用例交出真实的 HTTP 界面。
 *
 * 一切都在本地、在同一个 Bun 进程中运行：没有远程调用、没有密钥、没有产品后门。
 *  - 确定性的 DeepSeek 兼容夹具（`fixture-server.ts`），
 *    真实 AI SDK 通过服务端所组合的 `GenerateSpells` 接缝访问它；
 *  - 确定性的微信桥接（`wechat.ts`），它签发出服务端登录流程所校验的真实中继令牌；
 *  - 一个通过服务端自身 `openDatabase` 打开的 PGlite 数据库（含迁移）。
 *    测试环境持有该句柄并将其传入服务端实例，因此服务端与各测试用例共享同一个 Drizzle 实例 ——
 *    测试绝不重新打开数据库文件；
 *  - 应用服务端：稳定 API、游戏路径、管理维护界面与 `/health`
 *    共用一个监听器，全部处于严格的同源与微信会话规则之下；
 *  - 一个供 UI 使用的 Vite 开发服务器。它的 `/api` 代理转发到应用服务端 ——
 *    浏览器自身的源就是所配置的公开源，因此服务端真实的源门控保持严格，无需任何夹具专用改写。
 *
 * `restartServer()` 只停止并重启应用服务端（相同端口、相同数据库、
 * 相同维护状态 —— 维护状态是持久化的）—— 存活下来的正是数据库与房间运行时持久持有的内容。
 *
 * 实时数据（PGlite 数据目录、Vite 缓存）位于本次运行状态目录之下、
 * 一个与 worker 和本次启动相关的目录中，因此崩溃的 worker 进程 ——
 * 它无法执行干净的 `stop()` —— 留下的目录占用声明，是任何接替 worker 都绝不会撞上的位置。
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

/** 夹具针对该 key 作答；产品真实密钥绝不出现在测试中。 */
export const TEST_AI_KEY = 'test-fixture-key';
/** 测试环境编译进测试服务器的信息性构建标识。 */
export const TEST_BUILD_ID = 'e2e-harness';

export type RestartOptions = Partial<Pick<ServerConfig, 'inputPolicyMode'>>;

export interface Harness {
  /** 唯一的共享 Drizzle 实例（PGlite）：服务端与各测试用例唯一的数据库。 */
  readonly db: OpenedDatabase['db'];
  /** 实时地址簿；同时持久化以供跨进程读取方使用。 */
  info(): RuntimeInfo;
  /** 在相同端口与数据库上停止并重启应用服务端。 */
  restartServer(options?: RestartOptions): Promise<void>;
  /**
   * 使用测试环境的管理员会话 Cookie 调用公开 API 上的维护界面
   * （`/api/admin/maintenance`）—— 与管理员玩家浏览器所驱动的完全同一个界面。
   */
  admin<T>(
    path: string,
    init?: { method?: string; data?: unknown },
  ): Promise<{ status: number; body: T }>;
  /** 在夹具桥接上固定一个微信身份，例如与管理员绑定的昵称。 */
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

/** 在 `ms` 毫秒后解析；用于那些不能在卡住的关闭上无限等待的竞态场景。 */
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

/** 为唯一 UI 提供的单个 Vite 开发服务器：共享管线、隔离的依赖缓存。 */
async function bootUi(
  port: number,
  proxy: Record<string, ProxyOptions>,
): Promise<{ server: ViteDevServer; origin: string }> {
  // 按 worker、按运行隔离的依赖缓存。Vite 的优化器为每个 cacheDir 保留一个 `deps` 目录，
  // 并在最后一个写入方的配置哈希不一致时将其整体删除，
  // 因此共享缓存会在任意两个产出方（开发构建、测试环境）之间反复抖动，
  // 而一次崩溃的优化会让下次启动变成冷启动。隔离目录使本实例的缓存归自己所有。
  const cacheDir = path.join(WORKER_STATE_DIR, 'vite-cache', 'app');
  fs.mkdirSync(cacheDir, { recursive: true });
  const server = await createServer({
    configFile: path.join(ROOT, 'tests', 'vite.config.ts'),
    // 使用原生 TS 配置加载，与 scripts/dev.ts 一致：启动路径上没有配置打包步骤。
    configLoader: 'native',
    root: ROOT,
    cacheDir,
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy,
      // E2E 观测的是一套稳定的应用；持久性场景会显式重启服务端。
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
    // 监听之后就绪检查失败：立即关闭本实例，使失败的启动绝不会
    // 在一个注定失败的进程里留下仍在监听的 Vite 服务端（及其打包线程）。
    await Promise.race([server.close(), after(5000)]);
    throw error;
  }
}

let active: Harness | null = null;

/** 每个进程只启动一次测试环境；后续调用返回正在运行的实例。 */
export async function startHarness(): Promise<Harness> {
  if (active) return active;

  // 实时数据位于该 worker 自己的目录之下：崩溃 worker 的接替者 ——
  // 相同的 TEST_WORKER_INDEX、全新的进程 —— 会启动到全新路径，
  // 而不会撞上已经死掉的前驱所留下的 PGlite 目录占用声明。
  const databaseDir = path.join(WORKER_STATE_DIR, 'pglite');
  fs.mkdirSync(databaseDir, { recursive: true });
  const databaseUrl = `pglite://${databaseDir}`;

  const fixture: FixtureServer = await startFixtureServer();
  const bridge: WechatBridge = await startWechatBridge();
  // 各持有者定义在启动 try 块之外：失败的启动会精确回滚它已打开的内容，
  // 因此部分启动绝不会让本进程继续持有 PGlite 占用声明或监听中的 Socket ——
  // 两者都会毒化此后在本进程乃至接替 worker 中的每一次启动。
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
        // 测试中途失败的页面可能留下未关闭的 Socket；绝不让拆除流程卡在它们上面。
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
    // 数据库由测试环境持有，并把句柄传给服务端；关闭服务端绝不会关闭它。
    // 因此服务端与各测试用例看到的是同一个数据库。
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
    // UI 就是规范的公开源：浏览器自身的 Origin 请求头会未经修改地通过服务端的严格同源门控，
    // 无论直接访问页面还是经由代理。
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
      // 该测试套件会从同一个本地地址注册大量账号：
      // 在真实时间窗上提高尝试配额，并且绝不信任直连客户端所声明的转发地址。
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

    // 维护界面位于公开 API 上，且只信任服务端的账号角色。
    // 夹具账号镜像的是被授予权限的 UnionID 首次真实登录本会创建的内容，
    // 因此 `admin()` 驱动的正是管理员玩家浏览器所驱动的那些端点。
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
