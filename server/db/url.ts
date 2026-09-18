/**
 * The one place a database URL is interpreted.
 *
 * Two drivers share this module: PGlite for local development and tests, and Bun's native SQL
 * client for the production PostgreSQL server. URLs are parsed here — never with the WHATWG `URL`
 * constructor for `pglite://`, because `:memory:` is an illegal host and would throw before we
 * could classify the form. Anything malformed or unsupported is rejected outright; there is no
 * silent fallback to an in-memory database, which would silently fork developer data.
 */

export class DatabaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseUrlError';
  }
}

/** A classified database URL. `pglite-memory` opens a throwaway in-process database. */
export type ParsedDatabaseUrl =
  | { driver: 'pglite'; dataDir: string }
  | { driver: 'pglite-memory' }
  | { driver: 'postgres'; connectionString: string };

const PGLITE_PREFIX = 'pglite://';
const POSTGRES_SCHEMES: Record<string, true> = { 'postgres:': true, 'postgresql:': true };

const SUPPORTED_FORMS =
  'supported forms: pglite://./relative/path, pglite:///absolute/path, pglite://:memory:, postgresql://host/db';

function reject(why: string): never {
  // Never echo the raw URL back: PostgreSQL connection strings routinely carry credentials.
  throw new DatabaseUrlError(`Unsupported database URL (${why}). ${SUPPORTED_FORMS}`);
}

/**
 * Classifies a database URL without touching the filesystem or the network, so both the runtime
 * (`openDatabase`) and the Drizzle CLI config can share one grammar.
 */
export function parseDatabaseUrl(raw: string): ParsedDatabaseUrl {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (url === '') reject('the URL is empty');

  if (url.startsWith(PGLITE_PREFIX)) {
    const rest = url.slice(PGLITE_PREFIX.length);
    if (rest === ':memory:') return { driver: 'pglite-memory' };
    if (rest === '' || rest.includes('?') || rest.includes('#')) {
      reject('pglite URLs take a bare filesystem path or :memory:');
    }
    if (rest.startsWith('/')) return { driver: 'pglite', dataDir: rest };
    if (rest.startsWith('./')) return { driver: 'pglite', dataDir: rest };
    reject('pglite data directories start with "/" or "./"');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    reject('the URL does not parse');
  }
  if (!POSTGRES_SCHEMES[parsed.protocol]) {
    reject(`scheme ${JSON.stringify(parsed.protocol)} is not a database driver`);
  }
  // PostgreSQL connection strings are passed through untouched; `pg` owns their grammar
  // (hosts, ports, sslmode, unix sockets and so on).
  return { driver: 'postgres', connectionString: url };
}
