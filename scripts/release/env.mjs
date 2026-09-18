// Resolves the effective release context: deploy/compose.env values (process
// environment wins for overrides), state directory layout, the admin bearer
// token and the single source of naming truth (base compose project, shared
// runtime network, per-release game projects, host ports). Secrets are
// always files under <stateDir>/secrets on the host; they are never accepted
// on the command line and never logged.

import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ADMIN_TOKEN_PATTERN,
  COMPOSE_PROJECT_PATTERN,
  composeEnvFile,
  repoRoot,
} from './constants.mjs';

const SECRET_FILES = {
  database_url: 'postgres://... URL for api/game runtimes',
  release_admin_token: '64 lowercase hex admin bearer token',
  postgres_password: 'database superuser password (base stack)',
  deepseek_api_key: 'DeepSeek API key for game runtimes',
};

const BASE_SECRETS = ['database_url', 'release_admin_token', 'postgres_password'];
const GAME_SECRETS = ['database_url', 'release_admin_token', 'deepseek_api_key'];

export function parseEnvFile(text) {
  const vars = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return vars;
}

export async function readAdminToken() {
  const inline = process.env.RELEASE_ADMIN_TOKEN?.trim();
  const tokenFile = process.env.RELEASE_ADMIN_TOKEN_FILE?.trim();
  if (inline && tokenFile)
    throw new Error('Set only RELEASE_ADMIN_TOKEN or RELEASE_ADMIN_TOKEN_FILE, not both.');
  const token = tokenFile ? (await Bun.file(tokenFile).text()).trim() : inline;
  if (!token) {
    throw new Error(
      'The release CLI needs the admin token: export RELEASE_ADMIN_TOKEN (64 hex) or RELEASE_ADMIN_TOKEN_FILE.',
    );
  }
  if (!ADMIN_TOKEN_PATTERN.test(token)) {
    throw new Error('RELEASE_ADMIN_TOKEN must be 64 lowercase hexadecimal characters.');
  }
  return token;
}

export async function loadContext({
  secrets = [],
  requireOrigin = true,
  requireToken = true,
} = {}) {
  const fileVars = existsSync(composeEnvFile)
    ? parseEnvFile(await Bun.file(composeEnvFile).text())
    : {};
  const value = (key) => process.env[key]?.trim() || fileVars[key]?.trim();
  const publicOrigin = value('SPELLTYPE_PUBLIC_ORIGIN');
  if (requireOrigin && !publicOrigin) {
    throw new Error(
      'SPELLTYPE_PUBLIC_ORIGIN is not set. Copy deploy/compose.env.example to deploy/compose.env and fill it in.',
    );
  }
  const baseProject = value('SPELLTYPE_BASE_PROJECT') || 'spelltype';
  if (!COMPOSE_PROJECT_PATTERN.test(baseProject)) {
    throw new Error(
      `SPELLTYPE_BASE_PROJECT must match ${COMPOSE_PROJECT_PATTERN}, got "${baseProject}".`,
    );
  }
  const stateDir = resolve(value('SPELLTYPE_STATE_DIR') || join(repoRoot, '.releases'));
  const ctx = {
    fileVars,
    value,
    stateDir,
    baseProject,
    // Derived from the base project unless an explicit network name is set.
    runtimeNetwork: value('SPELLTYPE_RUNTIME_NETWORK') || `${baseProject}_runtime`,
    gameProject: (releaseId) => `${baseProject}-game-${releaseId}`,
    adminHostPort: value('SPELLTYPE_ADMIN_HOST_PORT') || '3001',
    artifactsDir: join(stateDir, 'artifacts'),
    assetsDir: join(stateDir, 'assets'),
    secretsDir: join(stateDir, 'secrets'),
    tmpDir: join(stateDir, 'tmp'),
    lockFile: join(stateDir, '.lock'),
    publicOrigin,
    apiImage: value('SPELLTYPE_API_IMAGE') || undefined,
    postgresUser: value('POSTGRES_USER') || 'spelltype',
    postgresDb: value('POSTGRES_DB') || 'spelltype',
    deepseekModel: value('DEEPSEEK_MODEL') || 'deepseek-flash',
    uid: value('SPELLTYPE_UID') || '1000',
    gid: value('SPELLTYPE_GID') || '1000',
    token: requireToken ? await readAdminToken() : null,
  };
  ctx.adminUrl = value('SPELLTYPE_ADMIN_URL') || `http://127.0.0.1:${ctx.adminHostPort}`;
  for (const dir of [ctx.stateDir, ctx.artifactsDir, ctx.assetsDir, ctx.secretsDir, ctx.tmpDir]) {
    await mkdir(dir, { recursive: true });
  }
  for (const name of secrets) await requireSecretFile(ctx, name);
  return ctx;
}

export function secretFile(ctx, name) {
  if (!(name in SECRET_FILES)) throw new Error(`Unknown secret "${name}".`);
  return join(ctx.secretsDir, name);
}

async function requireSecretFile(ctx, name) {
  const path = secretFile(ctx, name);
  if (!existsSync(path)) {
    throw new Error(
      `Missing secret file ${path} (${SECRET_FILES[name]}). Create it with: bun run deploy secrets`,
    );
  }
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
}

export function baseSecrets() {
  return [...BASE_SECRETS];
}

export function gameSecrets() {
  return [...GAME_SECRETS];
}

/** Interpolation environment for the base stack, driven only by the context. */
export function baseComposeEnv(ctx) {
  return {
    SPELLTYPE_STATE_DIR: ctx.stateDir,
    SPELLTYPE_BASE_PROJECT: ctx.baseProject,
    SPELLTYPE_RUNTIME_NETWORK: ctx.runtimeNetwork,
    SPELLTYPE_PUBLIC_ORIGIN: ctx.publicOrigin ?? '',
    SPELLTYPE_DOMAIN: ctx.value('SPELLTYPE_DOMAIN') ?? '',
    SPELLTYPE_CADDYFILE: ctx.value('SPELLTYPE_CADDYFILE') || 'Caddyfile',
    SPELLTYPE_HTTP_PORT: ctx.value('SPELLTYPE_HTTP_PORT') || '80',
    SPELLTYPE_HTTPS_PORT: ctx.value('SPELLTYPE_HTTPS_PORT') || '443',
    SPELLTYPE_ADMIN_HOST_PORT: ctx.adminHostPort,
    SPELLTYPE_UID: ctx.uid,
    SPELLTYPE_GID: ctx.gid,
    SPELLTYPE_API_IMAGE: ctx.apiImage || 'spelltype/api:stable',
    POSTGRES_USER: ctx.postgresUser,
    POSTGRES_DB: ctx.postgresDb,
  };
}

/** Interpolation environment for compose.release.yaml of one release. */
export function gameComposeEnv(ctx, releaseId, imageRef) {
  return {
    SPELLTYPE_STATE_DIR: ctx.stateDir,
    SPELLTYPE_RUNTIME_NETWORK: ctx.runtimeNetwork,
    SPELLTYPE_GAME_PROJECT: ctx.gameProject(releaseId),
    SPELLTYPE_PUBLIC_ORIGIN: ctx.publicOrigin,
    SPELLTYPE_RELEASE_ID: releaseId,
    SPELLTYPE_GAME_IMAGE: imageRef,
    SPELLTYPE_UID: ctx.uid,
    SPELLTYPE_GID: ctx.gid,
    DEEPSEEK_MODEL: ctx.deepseekModel,
    MATCH_ADMISSION: ctx.value('MATCH_ADMISSION') ?? 'open',
    INPUT_POLICY_MODE: ctx.value('INPUT_POLICY_MODE') ?? 'observe',
  };
}
