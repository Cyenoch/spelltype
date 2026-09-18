/**
 * Worker configuration for the E2E application instances.
 *
 * The root `wrangler.jsonc` stays the single source of truth: this module reads it,
 * rewrites only what must differ for an isolated test instance (absolute entry and
 * migrations paths, a per-instance D1 database name, test vars) and writes the result
 * into `tests/.state/configs/`. Placing the generated config in that directory also
 * means `.dev.vars` is looked up there, so a developer's real secrets are never used
 * by the test app.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface InstanceWorkerConfig {
  /** Absolute path of the generated config file. */
  configPath: string;
  /** D1 database name used by the instance. */
  databaseName: string;
}

interface WranglerDbEntry {
  binding?: string;
  database_name?: string;
  migrations_dir?: string;
}

interface WranglerConfig {
  name?: string;
  main?: string;
  vars?: Record<string, unknown>;
  d1_databases?: WranglerDbEntry[];
  [key: string]: unknown;
}

/** Minimal JSONC reader: comments and trailing commas, string-aware. */
export function parseJsonc(text: string): Record<string, unknown> {
  let output = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        output += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    output += char;
  }

  return JSON.parse(output.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

export interface InstanceOptions {
  root: string;
  /** Directory that holds the generated configs (created when missing). */
  configDir: string;
  /** Short instance name, used for the worker name and D1 database name. */
  instance: string;
  /** Vars added on top of the root config. */
  vars: Record<string, string>;
  /**
   * Test-only rate-limit budget for this isolated runtime (Main authorized raising it for the
   * general instances so the suite is not dominated by real budget windows). The dedicated
   * limiter instance leaves this undefined and therefore keeps the production budget that
   * spec 13 exercises; the product config is never modified.
   */
  limiterLimit?: number;
}

interface RateLimitEntry {
  simple?: { limit?: number; period?: number };
  [key: string]: unknown;
}

export function writeInstanceConfig(options: InstanceOptions): InstanceWorkerConfig {
  const rootConfigPath = path.join(options.root, 'wrangler.jsonc');
  const base = parseJsonc(fs.readFileSync(rootConfigPath, 'utf8')) as WranglerConfig;
  const databaseName = `${base.d1_databases?.[0]?.database_name ?? 'spelltype'}-${options.instance}`;

  const config: WranglerConfig = {
    ...base,
    name: `${base.name ?? 'spelltype'}-${options.instance}`,
    main: path.resolve(options.root, base.main ?? 'worker/index.ts'),
    vars: { ...base.vars, ...options.vars },
    d1_databases: (base.d1_databases ?? []).map((entry) => ({
      ...entry,
      database_name: databaseName,
      migrations_dir: entry.migrations_dir ? path.resolve(options.root, entry.migrations_dir) : undefined,
    })),
    ratelimits: (base.ratelimits as RateLimitEntry[] | undefined)?.map((entry) =>
      options.limiterLimit === undefined || !entry.simple ? entry : { ...entry, simple: { ...entry.simple, limit: options.limiterLimit } },
    ),
  };

  fs.mkdirSync(options.configDir, { recursive: true });
  const configPath = path.join(options.configDir, `${options.instance}.json`);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, databaseName };
}
