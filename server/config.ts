import { resolve } from 'node:path';
import { z } from 'zod';
import type { InputPolicyMode } from '../shared/protocol';
import { DEFAULT_OPENROUTER_MODEL } from './generation/provider';

declare const __SPELLTYPE_BUILD_ID__: string;

export interface AiConfig {
  apiKey: string | null;
  model: string;
}

export interface AuthRateLimit {
  attempts: number;
  windowMs: number;
}

export interface ServerConfig {
  /** 仅用于展示的信息标识；绝不作为房间所有者、路由或准入规则。 */
  buildId: string;
  databaseUrl: string;
  hostname: string;
  port: number;
  publicOrigin: string;
  /** 可选的机器凭证；绝不用于管理员会话的身份认证。 */
  maintenanceToken: string | null;
  assetsRoot: string | null;
  authLimits: AuthRateLimit;
  wechatBridge: { baseUrl: string; appId: string; appKey: string } | null;
  /** 受信任的客户端 IP 请求头，若为 false 则使用连接的对端地址。 */
  trustForwardedFor: string | false;
  inputPolicyMode: InputPolicyMode;
  ai: AiConfig;
}

type Environment = Record<string, string | undefined>;
const portSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(65535));
const authLimitsSchema = z.object({
  attempts: z.coerce.number().int().min(1).max(10_000),
  windowMs: z.coerce.number().int().min(1_000).max(3_600_000),
});
const inputPolicySchema = z.enum(['observe', 'enforce']);

/** 基于文件的机密与环境变量中的机密互斥，不可同时配置。 */
async function secret(environment: Environment, name: string): Promise<string | undefined> {
  const inline = environment[name];
  const filename = environment[`${name}_FILE`];
  if (inline !== undefined && filename !== undefined) {
    throw new Error(`Set only ${name} or ${name}_FILE, not both.`);
  }
  return filename === undefined ? inline?.trim() : (await Bun.file(filename).text()).trim();
}

/** CLI 报表、迁移与服务启动共享相同的数据库选择和机密处理逻辑。 */
export async function readDatabaseUrl(environment: Environment = Bun.env): Promise<string> {
  const production = environment.NODE_ENV === 'production';
  const url =
    (await secret(environment, 'DATABASE_URL')) ?? (production ? '' : 'pglite://./.data/spelltype');
  if (!url) throw new Error('DATABASE_URL is required.');
  if (production && !/^postgres(?:ql)?:\/\//.test(url)) {
    throw new Error('Production requires PostgreSQL, not a shared PGlite directory.');
  }
  return url;
}

export async function readServerConfig(environment: Environment = Bun.env): Promise<ServerConfig> {
  const production = environment.NODE_ENV === 'production';
  const [databaseUrl, apiKey, bridgeAppKey, configuredMaintenanceToken] = await Promise.all([
    readDatabaseUrl(environment),
    secret(environment, 'OPENROUTER_API_KEY'),
    secret(environment, 'WECHAT_BRIDGE_APP_KEY'),
    secret(environment, 'MAINTENANCE_TOKEN'),
  ]);
  const maintenanceToken = configuredMaintenanceToken ?? null;
  if (maintenanceToken !== null && !/^[0-9a-f]{64}$/.test(maintenanceToken)) {
    throw new Error('MAINTENANCE_TOKEN must contain 64 lowercase hexadecimal characters.');
  }
  const originText = environment.PUBLIC_ORIGIN ?? (production ? '' : 'http://127.0.0.1:5173');
  if (!originText) throw new Error('PUBLIC_ORIGIN is required in production.');
  const origin = new URL(originText);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      'PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment.',
    );
  }
  const bridgeBaseUrl = environment.WECHAT_BRIDGE_BASE_URL?.trim();
  const bridgeAppId = environment.WECHAT_BRIDGE_APP_ID?.trim();
  let wechatBridge: ServerConfig['wechatBridge'] = null;
  if (bridgeBaseUrl || bridgeAppId || bridgeAppKey) {
    if (!bridgeBaseUrl || !bridgeAppId || !bridgeAppKey || bridgeAppKey.length < 16) {
      throw new Error(
        'WeChat login requires WECHAT_BRIDGE_BASE_URL, WECHAT_BRIDGE_APP_ID and WECHAT_BRIDGE_APP_KEY (at least 16 characters).',
      );
    }
    const bridgeUrl = new URL(bridgeBaseUrl);
    if (
      !['http:', 'https:'].includes(bridgeUrl.protocol) ||
      bridgeUrl.username ||
      bridgeUrl.password ||
      bridgeUrl.pathname !== '/' ||
      bridgeUrl.search ||
      bridgeUrl.hash ||
      (production && bridgeUrl.protocol !== 'https:')
    ) {
      throw new Error(
        'WECHAT_BRIDGE_BASE_URL must be an HTTP(S) origin without credentials, path, query or fragment; production requires HTTPS.',
      );
    }
    wechatBridge = { baseUrl: bridgeUrl.origin, appId: bridgeAppId, appKey: bridgeAppKey };
  }
  if (production && !wechatBridge)
    throw new Error('WeChat bridge configuration is required in production.');
  const forwardedHeader = environment.TRUST_FORWARDED_FOR?.trim().toLowerCase();
  return {
    buildId: typeof __SPELLTYPE_BUILD_ID__ === 'undefined' ? 'development' : __SPELLTYPE_BUILD_ID__,
    databaseUrl,
    hostname: environment.HOST ?? '127.0.0.1',
    port: portSchema.parse(environment.PORT ?? '3000'),
    publicOrigin: origin.origin,
    maintenanceToken,
    wechatBridge,
    assetsRoot: environment.ASSETS_ROOT
      ? resolve(environment.ASSETS_ROOT)
      : production
        ? resolve('dist/client')
        : null,
    authLimits: authLimitsSchema.parse({
      attempts: environment.AUTH_RATE_LIMIT_ATTEMPTS ?? '10',
      windowMs: environment.AUTH_RATE_LIMIT_WINDOW_MS ?? '60000',
    }),
    trustForwardedFor:
      !forwardedHeader || forwardedHeader === 'false'
        ? false
        : forwardedHeader === 'true'
          ? 'x-forwarded-for'
          : forwardedHeader,
    inputPolicyMode: inputPolicySchema.parse(environment.INPUT_POLICY_MODE ?? 'observe'),
    ai: {
      apiKey: apiKey || null,
      model: environment.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL,
    },
  };
}
