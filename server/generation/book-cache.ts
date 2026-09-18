import { and, eq } from 'drizzle-orm';
import { THEME_PRESETS, type Spell } from '../../shared/protocol';
import type { GenerateSpells } from '../contracts';
import type { Database, QueryDatabase } from '../db';
import { spellBookCache } from '../db/schema';
import { FAILURE_MESSAGES, GENERATION_BUDGET_MS } from './spells';
import type { GenerationFailure, GenerationInput, GenerationOutcome } from './spells';

/**
 * One shared preset book per theme. Claims recheck freshness under a row lock; publication and
 * failure clearing are token-fenced updates. Provider work runs outside every transaction.
 */

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

/**
 * How often a cold reader re-checks a lease it does not own. The lease belongs to another
 * process (every transition is a database statement, so there is no shared memory to consult),
 * and that owner may publish at any moment: re-checking in bounded steps serves a freshly
 * published book within this cadence instead of after the full remaining lease window.
 */
export const BOOK_LEASE_RECHECK_MS = 250;

/** The one row of one theme's cache: the published book, when it was published, and any live lease. */
interface CacheRow {
  book: Spell[] | null;
  publishedAt: number | null;
  token: string | null;
  leaseExpiresAt: number | null;
}

const EMPTY_ROW: CacheRow = { book: null, publishedAt: null, token: null, leaseExpiresAt: null };

async function readRow(database: QueryDatabase, theme: string, lock?: 'update'): Promise<CacheRow> {
  const query = database
    .select({
      book: spellBookCache.book,
      published_at: spellBookCache.published_at,
      token: spellBookCache.token,
      lease_expires_at: spellBookCache.lease_expires_at,
    })
    .from(spellBookCache)
    .where(eq(spellBookCache.theme, theme))
    .limit(1);
  const rows = await (lock === undefined ? query : query.for(lock));
  const row = rows[0];
  if (row === undefined) return EMPTY_ROW;
  return {
    // A stored book that is not an array leaves the cache empty rather than failing the read path.
    book: Array.isArray(row.book) ? row.book : null,
    publishedAt: row.published_at,
    token: row.token,
    leaseExpiresAt: row.lease_expires_at,
  };
}

/**
 * Recheck the decoded book and the live lease under the theme row lock. A publisher can finish
 * after the caller's first read; that publication must prevent a second billed generation.
 * The transaction commits its claim before any provider work begins.
 */
async function claimLease(
  database: Database,
  theme: string,
  token: string,
  clock: () => number,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    await tx.insert(spellBookCache).values({ theme }).onConflictDoNothing();
    const state = await readRow(tx, theme, 'update');
    if (state === EMPTY_ROW) return false;
    const now = clock();
    if (state.token !== null && state.leaseExpiresAt !== null && state.leaseExpiresAt > now)
      return false;
    if (
      state.book !== null &&
      state.publishedAt !== null &&
      state.publishedAt + BOOK_FRESH_MS > now
    )
      return false;
    await tx
      .update(spellBookCache)
      .set({ token, lease_expires_at: now + BOOK_LEASE_MS })
      .where(eq(spellBookCache.theme, theme));
    return true;
  });
}

/** Publishes book + a fresh publication time and clears the lease — only for the current token. */
async function publishBook(
  database: Database,
  theme: string,
  token: string,
  spells: Spell[],
  publishedAt: number,
): Promise<boolean> {
  const rows = await database
    .update(spellBookCache)
    .set({ book: spells, published_at: publishedAt, token: null, lease_expires_at: null })
    .where(and(eq(spellBookCache.theme, theme), eq(spellBookCache.token, token)))
    .returning();
  return rows.length === 1;
}

/** A settled failure clears only the lease; the book and its publication time stay untouched. */
async function clearLease(database: QueryDatabase, theme: string, token: string): Promise<void> {
  await database
    .update(spellBookCache)
    .set({ token: null, lease_expires_at: null })
    .where(and(eq(spellBookCache.theme, theme), eq(spellBookCache.token, token)));
}

/** Narrow clock/sleep seams so tests drive real databases with a fixed clock. */
export interface ThemeBookCacheOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** One theme's in-flight refresh, shared in memory so cold readers coalesce instead of re-billing. */
interface Pending {
  token: string;
  promise: Promise<SpellBookOutcome>;
}

/**
 * The shared spell book for THEME_PRESETS themes: one database row per theme, one instance per
 * process. The rules, in order:
 *
 * 1. A live attempt in this process is authoritative for as long as it runs — whether or not its
 *    lease has lapsed, because the claim is written before the generation budget even starts,
 *    and only while the row still carries its token. Old-book readers get the current book
 *    immediately; a cold cache coalesces onto the one in-flight refresh and observes its real
 *    final result, success or rejection.
 * 2. Only when no live attempt is known locally does the row's lease speak for a remote owner —
 *    another process, or a lost one after a restart. An old book still serves immediately; a
 *    cold cache re-checks in bounded steps so the owner's publication is served promptly, and
 *    holds out only a dead lease's remaining window before recovering.
 * 3. A book published within BOOK_FRESH_MS is served as-is; nothing is billed.
 * 4. Otherwise — empty or stale, no live attempt — this request owns exactly one refresh: it
 *    claims the lease after a row-locked freshness recheck (a racing loser re-reads instead of
 *    double-billing), generates once (the generator's own bounded retry policy applies inside),
 *    publishes on success, and clears the lease on failure. The next request after a settled
 *    failure may retry immediately; there is no failure cooldown.
 */
export class ThemeBookCache {
  private readonly database: Database;
  private readonly generate: GenerateSpells;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pending = new Map<string, Pending>();

  constructor(database: Database, generate: GenerateSpells, options: ThemeBookCacheOptions = {}) {
    this.database = database;
    this.generate = generate;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * The shared entry point. Only THEME_PRESETS themes may be cached — preset rows are keyed by
   * the exact trimmed theme string, and custom themes are generated per match by the caller. A
   * non-preset theme here is an internal contract violation, so it fails loudly without a model
   * call; `createSpellBookGenerator` routes custom themes around this class instead.
   */
  async getSpellBook(rawTheme: string): Promise<SpellBookOutcome> {
    const theme = rawTheme.trim();
    if (!THEME_PRESETS.some((preset) => preset.theme === theme)) {
      throw new Error(
        `spell-book cache: theme is not a THEME_PRESETS member; custom themes are never cached`,
      );
    }

    for (;;) {
      let state = await readRow(this.database, theme);
      for (;;) {
        const now = this.now();
        const pending = this.pending.get(theme);

        if (pending !== undefined && pending.token === state.token) {
          if (state.book !== null) return { ok: true, spells: state.book };
          return await pending.promise;
        }

        if (state.token !== null && state.leaseExpiresAt !== null && state.leaseExpiresAt > now) {
          // The lease belongs to a remote or lost owner: an old book still serves immediately,
          // and a cold cache re-checks in bounded steps — the owner's publication shows up on
          // the next read instead of after the full remaining window.
          if (state.book !== null) return { ok: true, spells: state.book };
          const waitingFor = state.token;
          await this.sleep(Math.min(BOOK_LEASE_RECHECK_MS, state.leaseExpiresAt - now));
          state = await readRow(this.database, theme);
          // The attempt ended or was superseded without a publication. Do not silently bill a
          // second attempt for this waiter; a new request may claim the now-empty cache.
          if (state.book === null && state.token !== waitingFor) {
            return { ok: false, reason: 'upstream', message: FAILURE_MESSAGES.upstream };
          }
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

      // Empty or stale with no live attempt: this request owns exactly one refresh. The claim
      // can still lose to a racing process that judged the same row first; then the row holds a
      // fresh foreign lease and the loop above decides again.
      const token = crypto.randomUUID();
      if (!(await claimLease(this.database, theme, token, this.now))) continue;
      const refreshing = this.refresh(theme, token);
      this.pending.set(theme, { token, promise: refreshing });
      try {
        return await refreshing;
      } finally {
        if (this.pending.get(theme)?.token === token) this.pending.delete(theme);
      }
    }
  }

  /**
   * One refresh, end to end: claim durably, generate once, publish or clear, then report. The
   * promise this returns is the same object every cold coalescer awaits, so they see exactly
   * what this caller sees — including a database failure that rejects the whole refresh.
   */
  private async refresh(theme: string, token: string): Promise<SpellBookOutcome> {
    // The claim is already committed (the caller awaited it before calling), so a crash here
    // cannot lose the lease, and no provider work runs under any database lock.
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
      const published = await publishBook(this.database, theme, token, outcome.spells, this.now());
      if (!published) {
        outcome = { ok: false, reason: 'upstream', message: FAILURE_MESSAGES.upstream };
      }
    } else {
      await clearLease(this.database, theme, token);
    }

    const latest = await readRow(this.database, theme);
    // The settled owner shares the old book when one exists — on failure as well — and only a
    // cache miss gets the explicit failure, exactly like a direct per-match generation.
    if (latest.book !== null) return { ok: true, spells: latest.book };
    return outcome;
  }
}

/**
 * The production composition: wraps a `GenerateSpells` (the per-match generator `startServer`
 * builds from the configured provider, or an injected fixture) so that THEME_PRESETS themes are
 * served through the shared cache and everything else passes through untouched — custom themes
 * keep their per-match generation and the caller's own variation.
 *
 * A success served from stored cache state reports `attempts: 0`: the response is a cache hit,
 * and the provider cost was paid once by whichever request performed the refresh — the outcome
 * a caller receives from the cache never claims an attempt of its own. Direct generations
 * (custom themes) pass the underlying outcome through verbatim.
 */
export function createSpellBookGenerator(
  database: Database,
  generate: GenerateSpells,
  options: ThemeBookCacheOptions = {},
): GenerateSpells {
  const presets = new ThemeBookCache(database, generate, options);
  return async (input: GenerationInput): Promise<GenerationOutcome> => {
    const theme = input.theme.trim();
    if (!THEME_PRESETS.some((preset) => preset.theme === theme)) return generate(input);
    const outcome = await presets.getSpellBook(theme);
    if (!outcome.ok) return outcome;
    return { ok: true, spells: outcome.spells, attempts: 0 };
  };
}
