import { readFileSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';
import { parseDatabaseUrl } from './server/db/url';

/**
 * Drizzle CLI configuration (migration generation and inspection).
 *
 * The URL comes from the same source and grammar the server uses: `DATABASE_URL`, or
 * `DATABASE_URL_FILE` for secret-file deployments — exactly as `server/config.ts` reads them — so
 * pointing the CLI at a database never uses a different variable than the server would. Only
 * `generate` needs no connection; commands that touch a database use whatever it points at. The
 * fallback is the dev server's own default database (PGlite), so plain `drizzle-kit generate`
 * works in a fresh checkout.
 */
const raw =
  process.env.DATABASE_URL ??
  (process.env.DATABASE_URL_FILE !== undefined
    ? readFileSync(process.env.DATABASE_URL_FILE, 'utf8')
    : 'pglite://./.data/spelltype');
const parsed = parseDatabaseUrl(raw);

export default defineConfig(
  parsed.driver === 'postgres'
    ? {
        dialect: 'postgresql',
        schema: './server/db/schema.ts',
        out: './drizzle',
        dbCredentials: { url: parsed.connectionString },
      }
    : {
        dialect: 'postgresql',
        driver: 'pglite',
        schema: './server/db/schema.ts',
        out: './drizzle',
        dbCredentials: { url: parsed.driver === 'pglite-memory' ? ':memory:' : parsed.dataDir },
      },
);
