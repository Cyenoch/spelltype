// Shared deploy CLI context: deploy/compose.env values (process environment
// wins for overrides), state directory layout, the standard COMPOSE_FILE set
// and compose naming. There is no application management secret: maintenance
// operations run one-shot inside the app container with the host's existing
// Docker privilege. Secrets are always files under <stateDir>/secrets on the
// host; they are never accepted on the command line and never logged.

import { existsSync, openSync, closeSync, writeSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpsClient } from './ops';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const SECRET_FILE_DOCS: Record<string, string> = {
  database_url: 'postgres://... URL for the app and one-shot containers',
  postgres_password: 'database superuser password',
  wechat_bridge_app_key:
    'WeChat bridge App Key from the xsg-website /developers App (server-side only)',
  deepseek_api_key: 'DeepSeek API key for spell generation',
  maintenance_token:
    'optional 64 lowercase hex bearer token for the /api/ops/maintenance machine API; absent disables only the ops API',
};

/** Secrets every deployment needs; the ops token is opt-in. */
export const SECRET_NAMES = [
  'database_url',
  'postgres_password',
  'wechat_bridge_app_key',
  'deepseek_api_key',
];

const OPS_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

/** Parses a compose-style env file: KEY=VALUE lines, `#` comments, no quoting tricks. */
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

  // Standard COMPOSE_FILE (colon-separated; paths relative to the repository
  // root) decides which compose files apply — operator and CLI always run the
  // exact same set, so CLI container recreates can never drop override layers
  // such as deploy/compose.dokploy.yaml routing.
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

/** Requires every compose secret to exist before any stack operation. */
export function requireAllSecrets(ctx: DeployContext): void {
  for (const name of SECRET_NAMES) requireSecretFile(ctx, name);
  // An operator who opted into the ops override must also provision its
  // token, or the app container would fail its secret mount at up.
  if (ctx.composeFiles.some((file) => file.endsWith('compose.ops.yaml'))) {
    requireSecretFile(ctx, 'maintenance_token');
  }
}

/** Creates one 0600 secret file; refuses to touch an existing file. */
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
 * Resolves the ops API bearer token: MAINTENANCE_TOKEN env, MAINTENANCE_TOKEN_FILE env,
 * or the state file `deploy secrets` creates when MAINTENANCE_TOKEN is exported.
 * Never accepted on the command line, never logged.
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
 * Builds the remote ops client without touching compose or the state dir:
 * SPELLTYPE_OPS_URL (explicit), else SPELLTYPE_PUBLIC_ORIGIN, else the local
 * loopback app port. Remote CI only needs these environment values — no
 * Docker access.
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
