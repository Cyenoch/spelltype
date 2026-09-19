// 部署 CLI 的共享上下文：包括 deploy/compose.env 的配置值（进程环境变量优先级高于配置文件）、
// 状态目录结构、标准 COMPOSE_FILE 文件集合以及 compose 命名规范。
// 此处不存在管理后台密码：维护操作直接利用宿主机已有的 Docker 权限在应用容器内以单次命令方式运行。
// 密钥一律以文件形式存放在宿主机上的 <stateDir>/secrets 目录下；
// 绝不通过命令行参数接收密钥，也绝不记录进日志。

import { existsSync, openSync, closeSync, writeSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpsClient } from './ops';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const SECRET_FILE_DOCS: Record<string, string> = {
  database_url: '应用及单次运行容器所使用的 postgres://... 连接 URL',
  postgres_password: 'database superuser password',
  wechat_bridge_app_key:
    'WeChat bridge App Key from the xsg-website /developers App (server-side only)',
  deepseek_api_key: 'DeepSeek API key for spell generation',
  maintenance_token:
    'optional 64 lowercase hex bearer token for the /api/ops/maintenance machine API; absent disables only the ops API',
};

/** 每次部署均必需的核心密钥；运维 API 令牌（ops token）为可选配置。 */
export const SECRET_NAMES = [
  'database_url',
  'postgres_password',
  'wechat_bridge_app_key',
  'deepseek_api_key',
];

const OPS_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** 解析 compose 风格的 env 文件：KEY=VALUE 行格式、`#` 注释行，无复杂引用语法。 */
export function parseEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return vars;
}

export interface DeployContext {
  fileVars: Record<string, string>;
  value(key: string): string | undefined;
  repoEnvFile: string;
  stateDir: string;
  secretsDir: string;
  tmpDir: string;
  stateFile: string;
  lockFile: string;
  project: string;
  composeFiles: string[];
  appHostPort: string;
  appBaseUrl: string;
  publicOrigin: string | undefined;
  uid: string;
  gid: string;
  postgresUser: string;
  postgresDb: string;
}

export async function loadContext(
  options: { requireOrigin?: boolean } = {},
): Promise<DeployContext> {
  const repoEnvFile = join(repoRoot, 'deploy', 'compose.env');
  if (!existsSync(repoEnvFile)) {
    throw new Error(
      'deploy/compose.env is missing. Copy deploy/compose.env.example to deploy/compose.env and fill it in.',
    );
  }
  const fileVars = parseEnvFile(await Bun.file(repoEnvFile).text());
  const value = (key: string) => process.env[key]?.trim() || fileVars[key]?.trim();

  const stateDir = resolve(value('SPELLTYPE_STATE_DIR') || join(repoRoot, '.deploy'));
  const project = value('SPELLTYPE_PROJECT') || 'spelltype';
  if (!COMPOSE_PROJECT_PATTERN.test(project)) {
    throw new Error(`SPELLTYPE_PROJECT must match ${COMPOSE_PROJECT_PATTERN}, got "${project}".`);
  }
  const publicOrigin = value('SPELLTYPE_PUBLIC_ORIGIN');
  if (options.requireOrigin && !publicOrigin) {
    throw new Error('SPELLTYPE_PUBLIC_ORIGIN is not set in the environment or deploy/compose.env.');
  }

  // 标准 COMPOSE_FILE（冒号分隔；路径相对于仓库根目录）
  // 决定生效的 compose 文件集合——运维人员与 CLI 始终使用完全相同的集合，
  // 确保 CLI 重建容器时绝不会丢失诸如 deploy/compose.dokploy.yaml 路由等覆盖层。
  const composeFileValue = value('COMPOSE_FILE') || 'compose.yaml';
  const composeFiles = composeFileValue
    .split(':')
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const path = resolve(repoRoot, entry);
      if (!existsSync(path)) {
        throw new Error(`COMPOSE_FILE entry ${entry} does not exist (resolved ${path}).`);
      }
      return path;
    });
  if (composeFiles.length === 0) {
    throw new Error('COMPOSE_FILE resolved to an empty compose file set.');
  }

  const ctx: DeployContext = {
    fileVars,
    value,
    repoEnvFile,
    stateDir,
    secretsDir: join(stateDir, 'secrets'),
    tmpDir: join(stateDir, 'tmp'),
    stateFile: join(stateDir, 'deploy-state.json'),
    lockFile: join(stateDir, '.deploy-lock'),
    project,
    composeFiles,
    appHostPort: value('SPELLTYPE_APP_HOST_PORT') || '3000',
    appBaseUrl: `http://127.0.0.1:${value('SPELLTYPE_APP_HOST_PORT') || '3000'}`,
    publicOrigin,
    uid: value('SPELLTYPE_UID') || '1000',
    gid: value('SPELLTYPE_GID') || '1000',
    postgresUser: value('POSTGRES_USER') || 'spelltype',
    postgresDb: value('POSTGRES_DB') || 'spelltype',
  };
  await mkdir(ctx.stateDir, { recursive: true });
  await mkdir(ctx.secretsDir, { recursive: true });
  await mkdir(ctx.tmpDir, { recursive: true });
  return ctx;
}

export function secretFile(ctx: DeployContext, name: string): string {
  if (!(name in SECRET_FILE_DOCS)) throw new Error(`Unknown secret "${name}".`);
  return join(ctx.secretsDir, name);
}

export function requireSecretFile(ctx: DeployContext, name: string): string {
  const path = secretFile(ctx, name);
  if (!existsSync(path)) {
    throw new Error(
      `Missing secret file ${path} (${SECRET_FILE_DOCS[name]}). Create it with: bun run deploy secrets`,
    );
  }
  if (!statSync(path).isFile()) throw new Error(`${path} is not a regular file.`);
  return path;
}

/** 在执行任何技术栈操作前，强制要求所有 compose 密钥文件必须存在。 */
export function requireAllSecrets(ctx: DeployContext): void {
  for (const name of SECRET_NAMES) requireSecretFile(ctx, name);
  // 若运维人员启用了 ops 覆盖配置，则必须同时提供其令牌文件，
  // 否则应用容器在启动（up）挂载密钥时将会失败。
  if (ctx.composeFiles.some((file) => file.endsWith('compose.ops.yaml'))) {
    requireSecretFile(ctx, 'maintenance_token');
  }
}

/** 创建单个权限为 0600 的密钥文件；若文件已存在则拒绝覆写。 */
export function createSecretFile(ctx: DeployContext, name: string, value: string): string {
  const path = secretFile(ctx, name);
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Secret file ${path} already exists; delete it deliberately to replace it.`);
    }
    throw error;
  }
  try {
    writeSync(fd, `${value}\n`);
  } finally {
    closeSync(fd);
  }
  return path;
}

/**
 * 解析运维 API 的 Bearer 令牌：依次检查 MAINTENANCE_TOKEN 环境变量、MAINTENANCE_TOKEN_FILE 环境变量，
 * 或当导出 MAINTENANCE_TOKEN 时由 `deploy secrets` 所创建的状态文件。
 * 绝不通过命令行参数传递，也绝不打印至日志。
 */
export async function readOpsToken(): Promise<string> {
  const inline = process.env.MAINTENANCE_TOKEN?.trim();
  const tokenFile = process.env.MAINTENANCE_TOKEN_FILE?.trim();
  if (inline !== undefined && tokenFile !== undefined) {
    throw new Error('Set only MAINTENANCE_TOKEN or MAINTENANCE_TOKEN_FILE, not both.');
  }
  let token = tokenFile !== undefined ? (await Bun.file(tokenFile).text()).trim() : inline;
  if (token === undefined) {
    const stateDir = resolve(process.env.SPELLTYPE_STATE_DIR?.trim() || join(repoRoot, '.deploy'));
    const fallback = join(stateDir, 'secrets', 'maintenance_token');
    if (!existsSync(fallback)) {
      throw new Error(
        `The ops API needs the maintenance token: export MAINTENANCE_TOKEN (64 hex), MAINTENANCE_TOKEN_FILE, or create ${fallback} with: MAINTENANCE_TOKEN=$(openssl rand -hex 32) bun run deploy secrets`,
      );
    }
    token = (await Bun.file(fallback).text()).trim();
  }
  if (!OPS_TOKEN_PATTERN.test(token)) {
    throw new Error('MAINTENANCE_TOKEN must contain 64 lowercase hexadecimal characters.');
  }
  return token;
}

/**
 * 构建远程运维客户端，无需触碰 compose 或状态目录：
 * 优先使用显式指定的 SPELLTYPE_OPS_URL，其次为 SPELLTYPE_PUBLIC_ORIGIN，
 * 兜底使用本地回环的应用端口。远端 CI 仅需提供这些环境变量即可，无需 Docker 权限。
 */
export async function loadOpsClient(): Promise<OpsClient> {
  const baseUrl =
    process.env.SPELLTYPE_OPS_URL?.trim() ||
    process.env.SPELLTYPE_PUBLIC_ORIGIN?.trim() ||
    `http://127.0.0.1:${process.env.SPELLTYPE_APP_HOST_PORT?.trim() || '3000'}`;
  const origin = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback))
  ) {
    throw new Error(
      'SPELLTYPE_OPS_URL must be an HTTPS origin without credentials, path, query or fragment; HTTP is allowed only on loopback.',
    );
  }
  return { baseUrl: origin.origin, token: await readOpsToken() };
}
