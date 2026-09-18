import { THEME_PRESETS } from '../../shared/protocol';
import type { Spell } from '../../shared/protocol';
import type { SqlStore } from '../sql';
import { FAILURE_MESSAGES, GENERATION_BUDGET_MS } from './spells';
import type { GenerationFailure, GenerationInput, GenerationOutcome } from './spells';

/**
 * What a shared-book request gets: a validated cached book, or the same honest, distinguishable
 * failure a direct generation would have produced. There is no fake or stale-marked-as-fresh book.
 */
export type SpellBookOutcome = { ok: true; spells: Spell[] } | GenerationFailure;

/**
 * Freshness is earned only by a successful publication: for this long after a book lands, every
 * due request is served from the cache and nothing is billed. A failed attempt never sets or
 * extends the window, and never blocks the next request from retrying.
 */
export const BOOK_FRESH_MS = 5 * 60_000;

/**
 * The durable in-flight lease spans exactly one worst-case generation measured from the claim.
 * It is crash protection: after a restart mid-generation, the next due request holds out the
 * remaining window before starting recovery, so a dead attempt's billing window is not
 * immediately re-entered. It is a conservative delay — not a guarantee that no upstream call is
 * somehow still running, and not a failure cooldown: a settled attempt clears its own lease, so
 * the next request after a failed refresh may retry immediately.
 */
export const BOOK_LEASE_MS = GENERATION_BUDGET_MS;

/** The one row of one theme's cache: the published book, when it was published, and any live lease. */
interface CacheRow {
  book: Spell[] | null;
  publishedAt: number | null;
  token: string | null;
  leaseExpiresAt: number | null;
}

const EMPTY_ROW: CacheRow = { book: null, publishedAt: null, token: null, leaseExpiresAt: null };

function createCacheSchema(sql: SqlStore): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS spell_book_cache (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      book_json TEXT,
      published_at INTEGER,
      token TEXT,
      lease_expires_at INTEGER
    )
  `);
}

/** An unreadable stored book leaves the cache empty rather than failing the read path. */
function decodeBook(json: string | null): Spell[] | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Spell[]) : null;
  } catch (error) {
    console.error(
      '[spell-book-cache] unreadable cached book',
      error instanceof Error ? error.name : typeof error,
    );
    return null;
  }
}

function readRow(sql: SqlStore): CacheRow {
  const rows = sql
    .exec<{
      book_json: string | null;
      published_at: number | null;
      token: string | null;
      lease_expires_at: number | null;
    }>('SELECT book_json, published_at, token, lease_expires_at FROM spell_book_cache WHERE id = 1')
    .toArray();
  const row = rows[0];
  if (row === undefined) return EMPTY_ROW;
  return {
    book: decodeBook(row.book_json),
    publishedAt: row.published_at,
    token: row.token,
    leaseExpiresAt: row.lease_expires_at,
  };
}

/**
 * The claim is the lock: one synchronous statement that preserves any published book while
 * recording who is generating until when. Because it runs before any provider call and every
 * later transition is a single guarded statement, a crash can only ever leave a lease that
 * expires — never a lost claim or an overwritten book.
 */
function claimLease(sql: SqlStore, token: string, leaseExpiresAt: number): void {
  sql.exec(
    `INSERT INTO spell_book_cache (id, book_json, published_at, token, lease_expires_at)
     VALUES (1, NULL, NULL, ?, ?)
     ON CONFLICT(id) DO UPDATE SET token = excluded.token, lease_expires_at = excluded.lease_expires_at`,
    token,
    leaseExpiresAt,
  );
}

/** Publishes book + a fresh publication time and clears the lease — only for the current token. */
function publishBook(sql: SqlStore, token: string, spells: Spell[], publishedAt: number): boolean {
  const cursor = sql.exec(
    `UPDATE spell_book_cache
     SET book_json = ?, published_at = ?, token = NULL, lease_expires_at = NULL
     WHERE id = 1 AND token = ?`,
    JSON.stringify(spells),
    publishedAt,
    token,
  );
  return cursor.rowsWritten === 1;
}

/** A settled failure clears only the lease; the book and its publication time stay untouched. */
function clearLease(sql: SqlStore, token: string): void {
  sql.exec(
    'UPDATE spell_book_cache SET token = NULL, lease_expires_at = NULL WHERE id = 1 AND token = ?',
    token,
  );
}

/** Everything the cache needs from the platform or the caller, injected so tests drive real SQL. */
export interface ThemeBookCacheDeps {
  sql: SqlStore;
  /** Durability gate: the platform's `storage.sync()`, awaited around provider I/O. */
  sync: () => Promise<void>;
  generate: (input: GenerationInput) => Promise<GenerationOutcome>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** One theme's in-flight refresh, shared in memory so cold readers coalesce instead of re-billing. */
interface Pending {
  token: string;
  promise: Promise<SpellBookOutcome>;
}

/**
 * The shared spell book for one THEME_PRESETS theme: one Durable Object per theme, one SQLite row
 * per object. The rules, in order:
 *
 * 1. A live attempt in this isolate is authoritative for as long as it runs — whether or not its
 *    lease has lapsed, because the claim is written before the generation budget even starts.
 *    Old-cache readers get the current book immediately; a cold cache coalesces onto the one
 *    in-flight refresh and observes its real final result, success or rejection.
 * 2. Only when no live attempt is known does the durable lease speak for a lost owner (a
 *    restart). An old book still serves immediately; a cold cache holds out the remaining lease
 *    before recovering, so a crashed attempt is not immediately re-billed. The hold is a
 *    conservative delay, not a guarantee about the provider.
 * 3. A book published within BOOK_FRESH_MS is served as-is; nothing is billed.
 * 4. Otherwise — empty or stale, no live attempt — this request owns exactly one refresh: it
 *    claims the lease durably, generates once (the generator's own bounded retry policy applies
 *    inside), publishes on success, and clears the lease on failure. The next request after a
 *    settled failure may retry immediately; there is no failure cooldown.
 */
export class ThemeBookCache {
  private readonly sql: SqlStore;
  private readonly sync: () => Promise<void>;
  private readonly generate: (input: GenerationInput) => Promise<GenerationOutcome>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private pending: Pending | null = null;

  constructor(deps: ThemeBookCacheDeps) {
    this.sql = deps.sql;
    this.sync = deps.sync;
    this.generate = deps.generate;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    createCacheSchema(this.sql);
  }

  /**
   * The shared RPC surface. Only THEME_PRESETS themes may be cached — the object name is the
   * exact trimmed theme, and custom themes are generated per match by the caller. A non-preset
   * theme here is an internal contract violation, so it fails loudly without a model call.
   */
  async getSpellBook(rawTheme: string): Promise<SpellBookOutcome> {
    const theme = rawTheme.trim();
    if (!THEME_PRESETS.some((preset) => preset.theme === theme)) {
      throw new Error(
        `spell-book cache: theme is not a THEME_PRESETS member; custom themes are never cached`,
      );
    }

    let state = readRow(this.sql);
    for (;;) {
      const now = this.now();
      const pending = this.pending?.token === state.token ? this.pending : null;

      if (pending !== null) {
        if (state.book !== null) return { ok: true, spells: state.book };
        return await pending.promise;
      }

      if (state.token !== null && state.leaseExpiresAt !== null && state.leaseExpiresAt > now) {
        // The lease belongs to a lost owner (restart): an old book still serves immediately,
        // and a cold cache holds out the lease, then recovers through the normal path below.
        if (state.book !== null) return { ok: true, spells: state.book };
        await this.sleep(state.leaseExpiresAt - now);
        state = readRow(this.sql);
        continue;
      }

      if (
        state.book !== null &&
        state.publishedAt !== null &&
        state.publishedAt + BOOK_FRESH_MS > now
      ) {
        return { ok: true, spells: state.book };
      }

      break;
    }

    // Empty or stale with no live attempt: this request owns exactly one refresh.
    const token = crypto.randomUUID();
    claimLease(this.sql, token, this.now() + BOOK_LEASE_MS);
    const refreshing = this.refresh(theme, token);
    this.pending = { token, promise: refreshing };
    try {
      return await refreshing;
    } finally {
      if (this.pending?.token === token) this.pending = null;
    }
  }

  /**
   * One refresh, end to end: sync the claim, generate once, publish or clear, sync again. The
   * promise this returns is the same object every cold coalescer awaits, so they see exactly
   * what this caller sees — including a storage failure that rejects the whole refresh.
   */
  private async refresh(theme: string, token: string): Promise<SpellBookOutcome> {
    // The claim is durable before any provider call, so a crash here cannot lose the lease.
    await this.sync();
    let outcome: GenerationOutcome;
    try {
      outcome = await this.generate({ theme, variation: token });
    } catch (error) {
      console.error(
        '[spell-book-cache] generation threw',
        error instanceof Error ? error.name : typeof error,
      );
      outcome = { ok: false, reason: 'upstream', message: FAILURE_MESSAGES.upstream };
    }

    // Each transition is one guarded statement: a late result whose token was superseded
    // publishes nothing and clears nothing, so it can never overwrite a newer generation —
    // and it is reported as a failure, never served unpersisted.
    if (outcome.ok) {
      const published = publishBook(this.sql, token, outcome.spells, this.now());
      if (!published) {
        outcome = { ok: false, reason: 'upstream', message: FAILURE_MESSAGES.upstream };
      }
    } else {
      clearLease(this.sql, token);
    }
    await this.sync();

    const latest = readRow(this.sql);
    // The settled owner shares the old book when one exists — on failure as well — and only a
    // cache miss gets the explicit failure, exactly like a direct per-match generation.
    if (latest.book !== null) return { ok: true, spells: latest.book };
    return outcome;
  }
}
