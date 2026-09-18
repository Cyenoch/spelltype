import { resolve } from 'node:path';
import { z } from 'zod';
import { DEV_RELEASE_ID, releaseIdSchema } from '../shared/release';
import type { InputPolicyMode } from '../shared/protocol';
import { DEFAULT_DEEPSEEK_MODEL } from './generation/provider';

declare const __SPELLTYPE_RELEASE_ID__: string;

export interface AiConfig {
  apiKey: string | null;
  model: string;
}

export interface AuthRateLimit {
  attempts: number;
  windowMs: number;
}

export interface ServerConfig {
  role: 'all' | 'api' | 'game';
  releaseId: string;
  databaseUrl: string;
  hostname: string;
  port: number;
  adminPort: number | null;
  publicOrigin: string;
  adminToken: string | null;
  assetsRoot: string | null;
  authLimits: AuthRateLimit;
  /** Enable only when this listener is reachable through the trusted reverse proxy. */
  trustForwardedFor: boolean;
  matchAdmission: 'open' | 'draining';
  inputPolicyMode: InputPolicyMode;
  ai: AiConfig;
}

type Environment = Record<string, string | undefined>;
const portSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().min(0).max(65535));
const roleSchema = z.enum(['all', 'api', 'game']);
const manifestSchema = z.object({ releaseId: releaseIdSchema });
const authLimitsSchema = z.object({
  attempts: z.coerce.number().int().min(1).max(10_000),
  windowMs: z.coerce.number().int().min(1_000).max(3_600_000),
});
const booleanSchema = z.enum(['true', 'false']).transform((value) => value === 'true');
const gamePolicySchema = z.object({
  MATCH_ADMISSION: z.enum(['open', 'draining']),
  INPUT_POLICY_MODE: z.enum(['observe', 'enforce']),
});

/** File-backed secrets and environment secrets are mutually exclusive. */
async function secret(environment: Environment, name: string): Promise<string | undefined> {
  const inline = environment[name];
  const filename = environment[`${name}_FILE`];
  if (inline !== undefined && filename !== undefined) {
    throw new Error(`Set only ${name} or ${name}_FILE, not both.`);
  }
  return filename === undefined ? inline?.trim() : (await Bun.file(filename).text()).trim();
}

/** CLI reports and service startup use the same secret handling and database selection. */
export async function readDatabaseUrl(environment: Environment = Bun.env): Promise<string> {
  const production = environment.NODE_ENV === 'production';
  const url =
    (await secret(environment, 'DATABASE_URL')) ?? (production ? '' : 'pglite://./.data/spelltype');
  if (!url) throw new Error('DATABASE_URL is required.');
  if (production && !/^postgres(?:ql)?:\/\//.test(url)) {
    throw new Error(
      'Production release processes require PostgreSQL, not a shared PGlite directory.',
    );
  }
  return url;
}

export async function readServerConfig(environment: Environment = Bun.env): Promise<ServerConfig> {
  const production = environment.NODE_ENV === 'production';
  const role = roleSchema.parse(environment.SERVER_ROLE ?? 'all');
  const policy = gamePolicySchema.parse({
    MATCH_ADMISSION: environment.MATCH_ADMISSION ?? 'open',
    INPUT_POLICY_MODE: environment.INPUT_POLICY_MODE ?? 'observe',
  });
  if (production && role === 'all') {
    throw new Error('Production requires SERVER_ROLE=api or SERVER_ROLE=game.');
  }
  const compiledRelease =
    typeof __SPELLTYPE_RELEASE_ID__ === 'undefined'
      ? undefined
      : releaseIdSchema.parse(__SPELLTYPE_RELEASE_ID__);
  if (production && !compiledRelease) {
    throw new Error('Production requires a release build with a compiled release identity.');
  }

  let manifestRelease: string | undefined;
  if (compiledRelease || production || environment.RELEASE_MANIFEST) {
    const filename = environment.RELEASE_MANIFEST
      ? resolve(environment.RELEASE_MANIFEST)
      : resolve(import.meta.dir, '../release.json');
    manifestRelease = manifestSchema.parse(await Bun.file(filename).json()).releaseId;
  }
  if (compiledRelease && manifestRelease !== compiledRelease) {
    throw new Error('The release manifest does not match this server build.');
  }
  const configuredRelease = environment.SPELLTYPE_RELEASE_ID;
  if (manifestRelease && configuredRelease && manifestRelease !== configuredRelease) {
    throw new Error('SPELLTYPE_RELEASE_ID does not match the immutable build manifest.');
  }
  const releaseId = releaseIdSchema.parse(
    compiledRelease ?? configuredRelease ?? manifestRelease ?? DEV_RELEASE_ID,
  );
  const [databaseUrl, configuredToken, apiKey] = await Promise.all([
    readDatabaseUrl(environment),
    secret(environment, 'RELEASE_ADMIN_TOKEN'),
    secret(environment, 'DEEPSEEK_API_KEY'),
  ]);

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
  const adminToken = configuredToken || null;
  if (adminToken !== null && !/^[0-9a-f]{64}$/.test(adminToken)) {
    throw new Error('RELEASE_ADMIN_TOKEN must contain 64 lowercase hexadecimal characters.');
  }
  if (production && !adminToken) throw new Error('RELEASE_ADMIN_TOKEN is required in production.');
  if (!adminToken && environment.ADMIN_PORT !== undefined) {
    throw new Error('ADMIN_PORT requires RELEASE_ADMIN_TOKEN.');
  }

  return {
    role,
    releaseId,
    databaseUrl,
    hostname: environment.HOST ?? '127.0.0.1',
    port: portSchema.parse(environment.PORT ?? '3000'),
    adminPort: adminToken ? portSchema.parse(environment.ADMIN_PORT ?? '3001') : null,
    publicOrigin: origin.origin,
    adminToken,
    assetsRoot: environment.ASSETS_ROOT ? resolve(environment.ASSETS_ROOT) : null,
    authLimits: authLimitsSchema.parse({
      attempts: environment.AUTH_RATE_LIMIT_ATTEMPTS ?? '10',
      windowMs: environment.AUTH_RATE_LIMIT_WINDOW_MS ?? '60000',
    }),
    trustForwardedFor: booleanSchema.parse(environment.TRUST_FORWARDED_FOR ?? 'false'),
    matchAdmission: policy.MATCH_ADMISSION,
    inputPolicyMode: policy.INPUT_POLICY_MODE,
    ai: {
      apiKey: apiKey || null,
      model: environment.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
    },
  };
}
