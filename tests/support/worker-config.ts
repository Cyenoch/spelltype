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
import { experimental_readRawConfig } from 'wrangler';

export interface InstanceWorkerConfig {
  /** Absolute path of the generated config file. */
  configPath: string;
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
  ratelimits?: RateLimitEntry[];
  [key: string]: unknown;
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
   * Test-only rate-limit budget for this isolated runtime. The suite registers several accounts
   * from one IP, so the generated per-instance config raises the budget; the product's own config
   * keeps its production budget and is never modified.
   */
  limiterLimit?: number;
}

interface RateLimitEntry {
  simple?: { limit?: number; period?: number };
  [key: string]: unknown;
}

export function writeInstanceConfig(options: InstanceOptions): InstanceWorkerConfig {
  const rootConfigPath = path.join(options.root, 'wrangler.jsonc');
  const base: WranglerConfig = experimental_readRawConfig({ config: rootConfigPath }).rawConfig;
  const databaseName = `${base.d1_databases?.[0]?.database_name ?? 'spelltype'}-${options.instance}`;
  for (const entry of base.d1_databases ?? []) {
    entry.database_name = databaseName;
    if (entry.migrations_dir)
      entry.migrations_dir = path.resolve(options.root, entry.migrations_dir);
  }
  if (options.limiterLimit !== undefined) {
    for (const entry of base.ratelimits ?? []) {
      if (entry.simple) entry.simple.limit = options.limiterLimit;
    }
  }

  const config: WranglerConfig = {
    ...base,
    name: `${base.name ?? 'spelltype'}-${options.instance}`,
    main: path.resolve(options.root, base.main ?? 'worker/index.ts'),
    vars: { ...base.vars, ...options.vars },
  };

  fs.mkdirSync(options.configDir, { recursive: true });
  const configPath = path.join(options.configDir, `${options.instance}.json`);
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath };
}
