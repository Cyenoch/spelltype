/**
 * Shared spell-book cache behavior — the per-theme state machine that decides when a preset
 * theme costs a model call, who waits for it, and what a crash or failure costs.
 *
 * `createSpellBookGenerator` is the exact composition the server wires, so these tests drive a
 * real PGlite database (the production open path, real Drizzle migrations) with a scripted
 * provider and a fixed clock. No network — every freshness, lease, fencing and retry rule is
 * asserted on what a caller of the wrapped generator can actually observe, including across a
 * simulated process restart that reopens the same PGlite data directory, and across two
 * independent generator instances sharing one database the way two server processes do.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { SPELL_BOOK_SIZE, THEME_PRESETS, type Spell } from '../../shared/protocol';
import {
  BOOK_FRESH_MS,
  BOOK_LEASE_MS,
  BOOK_LEASE_RECHECK_MS,
  createSpellBookGenerator,
} from '../../server/generation/book-cache';
import { FAILURE_MESSAGES } from '../../server/generation/spells';
import type { GenerationInput, GenerationOutcome } from '../../server/generation/spells';
import { openDatabase, spellBookCache, type Database, type OpenedDatabase } from '../../server/db';

const THEME = THEME_PRESETS[0].theme;
const OTHER_THEME = THEME_PRESETS[1].theme;
const T0 = 1_700_000_000_000;

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const NAME_BASES = [
  'Ember Bolt',
  'Frost Bind',
  'Storm Call',
  'Raven Mark',
  'Star Sigil',
  'Ice Veil',
  'Wind Verse',
  'Moon Eclipse',
];
const ZH_BASES = [
  '燃起余烬之焰',
  '冻结来敌脚步',
  '召来风暴轰击',
  '以鸦羽刻下印记',
  '星光结成封印',
  '寒冰织成面纱',
  '风吟成诗',
  '月影吞没一切',
];

/** An exact-`length` code point run of ASCII pseudo-words, distinct per `offset`. */
function wordRun(length: number, offset: number): string {
  let text = '';
  while (text.length < length) {
    if (text.length > 0 && length - text.length > 1) text += ' ';
    for (let at = 0; at < 4 && text.length < length; at += 1) {
      text += LETTERS[(offset + text.length) % LETTERS.length];
    }
  }
  return text;
}

/** A conforming book; `flavor` makes books from different generations distinguishable. */
function book(flavor: string): Spell[] {
  return Array.from({ length: SPELL_BOOK_SIZE }, (_, index) => ({
    name: `${NAME_BASES[index % NAME_BASES.length]} ${LETTERS[index % LETTERS.length].toUpperCase()}${flavor}`,
    text: wordRun(27, index),
    translation: `${ZH_BASES[index % ZH_BASES.length]}，第 ${index + 1} 条。`,
    element: (['arcane', 'fire', 'ice', 'storm'] as const)[index % 4],
  }));
}

/** The scripted provider surface: recorded calls plus a queue of outcomes, in order. */
interface GenerationScript {
  readonly calls: GenerationInput[];
  push(next: GenerationOutcome | Promise<GenerationOutcome>): void;
  generate(input: GenerationInput): Promise<GenerationOutcome>;
}

/** Records every generation input and hands out scripted outcomes in order. */
function scriptedGeneration(): GenerationScript {
  const calls: GenerationInput[] = [];
  const queue: Array<GenerationOutcome | Promise<GenerationOutcome>> = [];
  return {
    calls,
    push(next: GenerationOutcome | Promise<GenerationOutcome>): void {
      queue.push(next);
    },
    generate(input: GenerationInput): Promise<GenerationOutcome> {
      calls.push(input);
      const next = queue.shift();
      if (next === undefined) throw new Error('test generation script exhausted');
      return next instanceof Promise ? next : Promise.resolve(next);
    },
  };
}

interface Clock {
  now: number;
}

interface CacheRowSnapshot {
  book: Spell[] | null;
  publishedAt: number | null;
  token: string | null;
  leaseExpiresAt: number | null;
}

async function rowOf(db: Database, theme: string = THEME): Promise<CacheRowSnapshot | null> {
  const rows = await db
    .select()
    .from(spellBookCache)
    .where(eq(spellBookCache.theme, theme))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  return {
    book: Array.isArray(row.book) ? row.book : null,
    publishedAt: row.published_at,
    token: row.token,
    leaseExpiresAt: row.lease_expires_at,
  };
}

const openDatabases: OpenedDatabase[] = [];
const fileDirs: string[] = [];

/** A throwaway in-memory cache database on the real open path, registered for close. */
async function freshDatabase(): Promise<Database> {
  const opened = await openDatabase('pglite://:memory:');
  openDatabases.push(opened);
  return opened.db;
}

/**
 * A cache generator with a fixed clock and a recorded sleep that advances it (as a real sleep
 * would). A custom `sleep` adds behavior on top of the recording — e.g. holding a re-checking
 * reader until a gate opens — while the clock still advances like a real sleep's would.
 */
function makeCache(
  db: Database,
  clock: Clock,
  script: GenerationScript,
  sleep?: (ms: number) => Promise<void>,
) {
  const sleeps: number[] = [];
  const generate = createSpellBookGenerator(db, (input) => script.generate(input), {
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
      if (sleep !== undefined) await sleep(ms);
    },
  });
  return { generate, sleeps };
}

/** Resolves once the durable lease row shows a claimed generation, returning its token. */
async function waitUntilClaimed(db: Database, theme: string = THEME): Promise<string> {
  for (let poll = 0; poll < 2_000; poll += 1) {
    const token = (await rowOf(db, theme))?.token ?? null;
    if (token !== null) return token;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('generation was never claimed');
}

/** Runs the awaited outcome and asserts it rejects with a storage failure, not a fake result. */
async function rejectsWithStorageFailure(run: Promise<GenerationOutcome>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('expected the refresh to reject instead of reporting an unpersisted outcome');
}

/** Lets every microtask the current callers scheduled run before assertions. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

interface RestartableDatabase {
  db: Database;
  /** A second live handle on the same durable data directory, the way a restarted process would see it. */
  reopen: () => Promise<Database>;
}

async function openRestartableDatabase(): Promise<RestartableDatabase> {
  const dir = mkdtempSync(join(tmpdir(), 'spell-book-cache-'));
  fileDirs.push(dir);
  const first = await openDatabase(`pglite://${join(dir, 'cache')}`);
  openDatabases.push(first);
  return {
    db: first.db,
    reopen: async (): Promise<Database> => {
      await first.close();
      openDatabases.splice(openDatabases.indexOf(first), 1);
      const reopened = await openDatabase(`pglite://${join(dir, 'cache')}`);
      openDatabases.push(reopened);
      return reopened.db;
    },
  };
}

afterEach(async () => {
  const closed = await Promise.allSettled(openDatabases.splice(0).map((opened) => opened.close()));
  const failures = closed
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'Cache database cleanup failed');
  while (fileDirs.length > 0) {
    const dir = fileDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('共享咒语书缓存', () => {
  it('冷缓存首个请求生成并发布；五分钟内后续请求直接命中缓存，不再计费', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();
    const script = scriptedGeneration();
    const bookA = book('A');
    script.push({ ok: true, spells: bookA, attempts: 1 });
    const { generate } = makeCache(db, clock, script);

    expect(await generate({ theme: THEME, variation: 'match-1' })).toEqual({
      ok: true,
      spells: bookA,
      attempts: 0,
    });
    // The caller only sees the book once it is persisted and the lease is gone.
    const row = await rowOf(db);
    expect(row?.book).toEqual(bookA);
    expect(row?.publishedAt).toBe(T0);
    expect(row?.token).toBeNull();

    clock.now = T0 + BOOK_FRESH_MS - 1;
    expect(await generate({ theme: THEME, variation: 'match-2' })).toEqual({
      ok: true,
      spells: bookA,
      attempts: 0,
    });
    expect(script.calls).toHaveLength(1);
  });

  it('整整五分钟后新鲜期失效，下一次请求用新的刷新令牌按原主题重新生成', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();
    const script = scriptedGeneration();
    script.push({ ok: true, spells: book('A'), attempts: 1 });
    const { generate } = makeCache(db, clock, script);
    await generate({ theme: THEME, variation: 'match-1' });

    clock.now = T0 + BOOK_FRESH_MS;
    const bookB = book('B');
    script.push({ ok: true, spells: bookB, attempts: 1 });
    expect(await generate({ theme: THEME, variation: 'match-2' })).toEqual({
      ok: true,
      spells: bookB,
      attempts: 0,
    });
    expect(script.calls).toHaveLength(2);
    expect(script.calls[0].theme).toBe(THEME);
    expect(script.calls[1].theme).toBe(THEME);
    // The refresh token doubles as the variation: two generations never share one.
    expect(script.calls[1].variation).not.toBe(script.calls[0].variation);
  });

  it('有旧书时并发刷新：首个请求等待新书，其他读者立即拿到旧书', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();
    const script = scriptedGeneration();
    const firstBook = book('A');
    script.push({ ok: true, spells: firstBook, attempts: 1 });
    const { generate } = makeCache(db, clock, script);
    await generate({ theme: THEME, variation: 'match-1' });

    clock.now = T0 + BOOK_FRESH_MS + 1;
    const gate = Promise.withResolvers<GenerationOutcome>();
    script.push(gate.promise);
    const owner = generate({ theme: THEME, variation: 'match-2' });
    await waitUntilClaimed(db);

    const readerOutcome = await generate({ theme: THEME, variation: 'match-3' });
    expect(readerOutcome).toEqual({ ok: true, spells: firstBook, attempts: 0 });
    expect(script.calls).toHaveLength(2);

    const secondBook = book('B');
    gate.resolve({ ok: true, spells: secondBook, attempts: 1 });
    expect(await owner).toEqual({ ok: true, spells: secondBook, attempts: 0 });
  });

  it('冷缓存并发请求合并为一次生成，所有等待者拿到同一结果', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();
    const script = scriptedGeneration();
    const gate = Promise.withResolvers<GenerationOutcome>();
    script.push(gate.promise);
    const { generate } = makeCache(db, clock, script);

    const first = generate({ theme: THEME, variation: 'match-1' });
    await waitUntilClaimed(db);
    const second = generate({ theme: THEME, variation: 'match-2' });

    const bookA = book('A');
    gate.resolve({ ok: true, spells: bookA, attempts: 1 });
    const outcomes = await Promise.all([first, second]);
    expect(outcomes[0]).toEqual({ ok: true, spells: bookA, attempts: 0 });
    expect(outcomes[1]).toEqual({ ok: true, spells: bookA, attempts: 0 });
    expect(script.calls).toHaveLength(1);
  });

  it('进行中的生成比过期的租约优先：租约到期也不会发起第二次供应商调用', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();
    const script = scriptedGeneration();
    const gate = Promise.withResolvers<GenerationOutcome>();
    script.push(gate.promise);
    const { generate } = makeCache(db, clock, script);

    const first = generate({ theme: THEME, variation: 'match-1' });
    await waitUntilClaimed(db);
    // The claim precedes the generation budget, so the lease can lapse while the attempt lives.
    clock.now = T0 + BOOK_LEASE_MS + 1;
    const second = generate({ theme: THEME, variation: 'match-2' });
    await flushMicrotasks();
    expect(script.calls).toHaveLength(1);

    const bookP = book('P');
    gate.resolve({ ok: true, spells: bookP, attempts: 1 });
    expect(await second).toEqual({ ok: true, spells: bookP, attempts: 0 });
    expect(await first).toEqual({ ok: true, spells: bookP, attempts: 0 });
    expect(script.calls).toHaveLength(1);
  });

  it('空缓存生成失败：如实失败并清除租约，下一个请求立即重试', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();
    const script = scriptedGeneration();
    script.push({ ok: false, reason: 'upstream', message: FAILURE_MESSAGES.upstream });
    const { generate } = makeCache(db, clock, script);

    expect(await generate({ theme: THEME, variation: 'match-1' })).toEqual({
      ok: false,
      reason: 'upstream',
      message: FAILURE_MESSAGES.upstream,
    });
    const row = await rowOf(db);
    expect(row?.token).toBeNull();
    expect(row?.book).toBeNull();
    expect(row?.publishedAt).toBeNull();

    const bookA = book('A');
    script.push({ ok: true, spells: bookA, attempts: 1 });
    expect(await generate({ theme: THEME, variation: 'match-2' })).toEqual({
      ok: true,
      spells: bookA,
      attempts: 0,
    });
    expect(script.calls).toHaveLength(2);
  });

  it('有旧书时刷新失败：发起者拿到旧书，发布时间不动，下一请求立即重试', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();
    const script = scriptedGeneration();
    const oldBook = book('A');
    script.push({ ok: true, spells: oldBook, attempts: 1 });
    const { generate } = makeCache(db, clock, script);
    await generate({ theme: THEME, variation: 'match-1' });

    clock.now = T0 + BOOK_FRESH_MS + 1;
    script.push({ ok: false, reason: 'timeout', message: FAILURE_MESSAGES.timeout });
    expect(await generate({ theme: THEME, variation: 'match-2' })).toEqual({
      ok: true,
      spells: oldBook,
      attempts: 0,
    });
    const row = await rowOf(db);
    expect(row?.publishedAt).toBe(T0);
    expect(row?.token).toBeNull();

    const newBook = book('B');
    script.push({ ok: true, spells: newBook, attempts: 1 });
    expect(await generate({ theme: THEME, variation: 'match-3' })).toEqual({
      ok: true,
      spells: newBook,
      attempts: 0,
    });
    expect(script.calls).toHaveLength(3);
  });

  it('生成器抛出异常：如实转为失败、释放进行中的刷新，缓存随后仍可用', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();
    const script = scriptedGeneration();
    script.push(Promise.reject(new Error('provider socket died')));
    const { generate } = makeCache(db, clock, script);

    expect(await generate({ theme: THEME, variation: 'match-1' })).toEqual({
      ok: false,
      reason: 'upstream',
      message: FAILURE_MESSAGES.upstream,
    });
    expect((await rowOf(db))?.token).toBeNull();

    const bookA = book('A');
    script.push({ ok: true, spells: bookA, attempts: 1 });
    expect(await generate({ theme: THEME, variation: 'match-2' })).toEqual({
      ok: true,
      spells: bookA,
      attempts: 0,
    });
  });

  it('发布写入失败：等待者收到失败而不是未持久化的成功', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();
    const script = scriptedGeneration();
    const gate = Promise.withResolvers<GenerationOutcome>();
    script.push(gate.promise);
    const { generate } = makeCache(db, clock, script);

    const owner = generate({ theme: THEME, variation: 'match-1' });
    await waitUntilClaimed(db);
    const follower = generate({ theme: THEME, variation: 'match-2' });
    await flushMicrotasks();
    // The store dies before the outcome can be published: no caller may see an unpersisted book.
    const opened = openDatabases.pop();
    await opened?.close();
    gate.resolve({ ok: true, spells: book('A'), attempts: 1 });
    await rejectsWithStorageFailure(owner);
    await rejectsWithStorageFailure(follower);
    expect(script.calls).toHaveLength(1);
  });

  it('崩溃后的空缓存：重启后按有界重查等满剩余租约，再由该请求恢复', async () => {
    const restartable = await openRestartableDatabase();
    const clock: Clock = { now: T0 };

    // The crashed attempt never settles: its process is gone for good.
    const crashedScript = scriptedGeneration();
    crashedScript.push(Promise.withResolvers<GenerationOutcome>().promise);
    const before = makeCache(restartable.db, clock, crashedScript);
    void before.generate({ theme: THEME, variation: 'match-1' }).catch(() => undefined);
    await waitUntilClaimed(restartable.db);

    // The process dies mid-generation and comes back with the lease still on disk.
    const restartAt = T0 + Math.floor(BOOK_LEASE_MS / 2);
    clock.now = restartAt;
    const recoveredBook = book('R');
    const recoveryScript = scriptedGeneration();
    recoveryScript.push({ ok: true, spells: recoveredBook, attempts: 1 });
    const reopenedDb = await restartable.reopen();
    const after = makeCache(reopenedDb, clock, recoveryScript);

    expect(await after.generate({ theme: THEME, variation: 'match-2' })).toEqual({
      ok: true,
      spells: recoveredBook,
      attempts: 0,
    });
    // The remaining lease is held out through bounded re-checks, never one full-window sleep.
    expect(before.sleeps).toEqual([]);
    expect(after.sleeps.length).toBeGreaterThan(1);
    expect(after.sleeps.every((step) => step <= BOOK_LEASE_RECHECK_MS)).toBe(true);
    expect(after.sleeps.reduce((sum, step) => sum + step, 0)).toBe(T0 + BOOK_LEASE_MS - restartAt);
    expect(recoveryScript.calls).toHaveLength(1);
    const row = await rowOf(reopenedDb);
    expect(row?.book).toEqual(recoveredBook);
    expect(row?.token).toBeNull();
  });

  it('租约过期后的迟到结果：被令牌挡在新书之外，也绝不清除新主的租约或发布未持久化的书', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();

    // A stalled generation owns the lease, then goes silent past its whole budget — the
    // dead-owner shape another process must be able to recover from.
    const stalled = Promise.withResolvers<GenerationOutcome>();
    const staleScript = scriptedGeneration();
    staleScript.push(stalled.promise);
    const stale = makeCache(db, clock, staleScript);
    const staleCall = stale.generate({ theme: THEME, variation: 'match-1' });
    await waitUntilClaimed(db);
    clock.now = T0 + BOOK_LEASE_MS + 1;

    // A second instance takes over the expired lease and publishes a newer generation.
    const recoveredBook = book('R');
    const recoveryScript = scriptedGeneration();
    recoveryScript.push({ ok: true, spells: recoveredBook, attempts: 1 });
    const recovery = makeCache(db, clock, recoveryScript);
    expect(await recovery.generate({ theme: THEME, variation: 'match-2' })).toEqual({
      ok: true,
      spells: recoveredBook,
      attempts: 0,
    });

    // The late result's token was superseded: it publishes nothing, clears nothing, and the
    // settled owner reports the persisted current book — never its own unpersisted one.
    stalled.resolve({ ok: true, spells: book('C'), attempts: 1 });
    expect(await staleCall).toEqual({ ok: true, spells: recoveredBook, attempts: 0 });
    const row = await rowOf(db);
    expect(row?.book).toEqual(recoveredBook);
    expect(row?.token).toBeNull();
    expect(staleScript.calls).toHaveLength(1);
    expect(recoveryScript.calls).toHaveLength(1);
  });

  it('崩溃期间旧书仍在：读者立即拿到旧书，不等待也不重新计费', async () => {
    const restartable = await openRestartableDatabase();
    const clock: Clock = { now: T0 };

    const seedScript = scriptedGeneration();
    const oldBook = book('A');
    seedScript.push({ ok: true, spells: oldBook, attempts: 1 });
    const seed = makeCache(restartable.db, clock, seedScript);
    await seed.generate({ theme: THEME, variation: 'match-1' });

    clock.now = T0 + BOOK_FRESH_MS + 1;
    const stalled = Promise.withResolvers<GenerationOutcome>();
    const crashedScript = scriptedGeneration();
    crashedScript.push(stalled.promise);
    const crashed = makeCache(restartable.db, clock, crashedScript);
    void crashed.generate({ theme: THEME, variation: 'match-2' }).catch(() => undefined);
    await waitUntilClaimed(restartable.db);

    const restartedScript = scriptedGeneration();
    const restarted = makeCache(await restartable.reopen(), clock, restartedScript);
    expect(await restarted.generate({ theme: THEME, variation: 'match-3' })).toEqual({
      ok: true,
      spells: oldBook,
      attempts: 0,
    });
    expect(restarted.sleeps).toEqual([]);
    expect(restartedScript.calls).toHaveLength(0);
  });

  it('每个主题各自独立缓存：一个主题的租约不会拖慢另一个主题', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();

    const gate = Promise.withResolvers<GenerationOutcome>();
    const scriptA = scriptedGeneration();
    scriptA.push(gate.promise);
    const sideA = makeCache(db, clock, scriptA);
    void sideA.generate({ theme: THEME, variation: 'match-1' }).catch(() => undefined);
    await waitUntilClaimed(db);

    const bookB = book('B');
    const scriptB = scriptedGeneration();
    scriptB.push({ ok: true, spells: bookB, attempts: 1 });
    const sideB = makeCache(db, clock, scriptB);
    expect(await sideB.generate({ theme: OTHER_THEME, variation: 'match-2' })).toEqual({
      ok: true,
      spells: bookB,
      attempts: 0,
    });
    expect(sideB.sleeps).toEqual([]);
    expect(scriptB.calls).toHaveLength(1);
  });

  it('同一实例并发刷新不同主题时，冷缓存等待者仍收到原请求的失败', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();
    const script = scriptedGeneration();
    const first = Promise.withResolvers<GenerationOutcome>();
    const second = Promise.withResolvers<GenerationOutcome>();
    const ownerSettled = Promise.withResolvers<void>();
    script.push(first.promise);
    script.push(second.promise);
    const { generate } = makeCache(db, clock, script, () => ownerSettled.promise);
    const owner = generate({ theme: THEME, variation: 'first' });
    await waitUntilClaimed(db);
    const other = generate({ theme: OTHER_THEME, variation: 'other' });
    await waitUntilClaimed(db, OTHER_THEME);
    const follower = generate({ theme: THEME, variation: 'follower' });
    // PGlite serializes these real queries; this read follows the follower's cache read.
    await rowOf(db);
    await flushMicrotasks();
    const failure = { ok: false, reason: 'invalid', message: FAILURE_MESSAGES.invalid } as const;
    first.resolve(failure);
    const original = await owner;
    ownerSettled.resolve();
    second.resolve({ ok: true, spells: book('B'), attempts: 1 });
    const [repeated, otherResult] = await Promise.all([follower, other]);
    expect(original).toEqual(failure);
    expect(repeated).toEqual(failure);
    expect(otherResult).toEqual({ ok: true, spells: book('B'), attempts: 0 });
    expect(script.calls.map((input) => input.theme)).toEqual([THEME, OTHER_THEME]);
  });

  it('外部进程的存活租约：有界重查后及时看到发布，不睡满整个租约', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();

    // "Another process" owns the lease: an independent generator instance on the same database.
    const gate = Promise.withResolvers<GenerationOutcome>();
    const ownerScript = scriptedGeneration();
    ownerScript.push(gate.promise);
    const owner = makeCache(db, clock, ownerScript);
    const ownerCall = owner.generate({ theme: THEME, variation: 'match-1' });
    await waitUntilClaimed(db);

    // A cold reader on a second instance re-checks; its first wake waits until the owner has
    // really published, so the assertion below is deterministic.
    const published = Promise.withResolvers<void>();
    const readerScript = scriptedGeneration();
    const reader = makeCache(db, clock, readerScript, () => published.promise);
    const readerCall = reader.generate({ theme: THEME, variation: 'match-2' });
    await flushMicrotasks();
    expect(readerScript.calls).toHaveLength(0);

    const freshBook = book('F');
    gate.resolve({ ok: true, spells: freshBook, attempts: 1 });
    expect(await ownerCall).toEqual({ ok: true, spells: freshBook, attempts: 0 });
    published.resolve();
    expect(await readerCall).toEqual({ ok: true, spells: freshBook, attempts: 0 });
    // One bounded re-check — not the full remaining lease — stood between the reader and the book.
    expect(reader.sleeps).toEqual([Math.min(BOOK_LEASE_RECHECK_MS, BOOK_LEASE_MS)]);
    expect(ownerScript.calls).toHaveLength(1);
    expect(readerScript.calls).toHaveLength(0);
  });

  it('两个实例同时冷启动：只有一个生成，另一方等待并直接拿到发布的新书', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();
    const gate = Promise.withResolvers<GenerationOutcome>();
    const scriptA = scriptedGeneration();
    scriptA.push(gate.promise);
    const sideA = makeCache(db, clock, scriptA);
    // An empty script: if the second instance ever billed the provider, this test fails loudly.
    const scriptB = scriptedGeneration();
    const sideB = makeCache(db, clock, scriptB, () => published.promise);
    const published = Promise.withResolvers<void>();

    const callA = sideA.generate({ theme: THEME, variation: 'match-1' });
    const callB = sideB.generate({ theme: THEME, variation: 'match-2' });
    await waitUntilClaimed(db);

    const bookA = book('A');
    gate.resolve({ ok: true, spells: bookA, attempts: 1 });
    expect(await callA).toEqual({ ok: true, spells: bookA, attempts: 0 });
    published.resolve();
    expect(await callB).toEqual({ ok: true, spells: bookA, attempts: 0 });
    // Exactly one provider call: the second instance observed the first's lease and then its
    // publication, instead of re-billing the same cold theme.
    expect(scriptA.calls).toHaveLength(1);
    expect(scriptB.calls).toHaveLength(0);
    const row = await rowOf(db);
    expect(row?.book).toEqual(bookA);
    expect(row?.token).toBeNull();
  });

  it('失败结算会释放租约：另一个进程可以立即重试并成功', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();

    const failScript = scriptedGeneration();
    failScript.push({ ok: false, reason: 'invalid', message: FAILURE_MESSAGES.invalid });
    const failing = makeCache(db, clock, failScript);
    expect(await failing.generate({ theme: THEME, variation: 'match-1' })).toEqual({
      ok: false,
      reason: 'invalid',
      message: FAILURE_MESSAGES.invalid,
    });

    const retryScript = scriptedGeneration();
    const retryBook = book('B');
    retryScript.push({ ok: true, spells: retryBook, attempts: 1 });
    const retrying = makeCache(db, clock, retryScript);
    expect(await retrying.generate({ theme: THEME, variation: 'match-2' })).toEqual({
      ok: true,
      spells: retryBook,
      attempts: 0,
    });
    expect(retrying.sleeps).toEqual([]);
    const row = await rowOf(db);
    expect(row?.book).toEqual(retryBook);
    expect(row?.token).toBeNull();
  });

  it('外部刷新失败时等待者如实失败，只有后续显式请求才重新生成', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();
    const provider = Promise.withResolvers<GenerationOutcome>();
    const waiting = Promise.withResolvers<void>();
    const ownerSettled = Promise.withResolvers<void>();
    const ownerScript = scriptedGeneration();
    ownerScript.push(provider.promise);
    const owner = makeCache(db, clock, ownerScript);
    const first = owner.generate({ theme: THEME, variation: 'owner' });
    await waitUntilClaimed(db);
    const readerScript = scriptedGeneration();
    readerScript.push({ ok: true, spells: book('retry'), attempts: 1 });
    const reader = makeCache(db, clock, readerScript, async () => {
      waiting.resolve();
      await ownerSettled.promise;
    });
    const follower = reader.generate({ theme: THEME, variation: 'follower' });
    await waiting.promise;
    provider.resolve({ ok: false, reason: 'invalid', message: FAILURE_MESSAGES.invalid });
    const initial = await first;
    ownerSettled.resolve();
    const followed = await follower;
    expect(initial.ok).toBe(false);
    expect(followed.ok).toBe(false);
    expect(readerScript.calls).toEqual([]);
    expect(await reader.generate({ theme: THEME, variation: 'explicit-retry' })).toEqual({
      ok: true,
      spells: book('retry'),
      attempts: 0,
    });
    expect(readerScript.calls).toHaveLength(1);
  });

  it('自定义主题绕过缓存：调用者的 variation 原样传递，缓存行不受影响', async () => {
    const clock: Clock = { now: T0 };
    const db = await freshDatabase();
    const script = scriptedGeneration();
    const customBook = book('X');
    script.push({ ok: true, spells: customBook, attempts: 1 });
    const { generate } = makeCache(db, clock, script);

    const outcome = await generate({ theme: '完全自定义的主题', variation: 'match-9' });
    expect(outcome).toEqual({ ok: true, spells: customBook, attempts: 1 });
    expect(script.calls).toEqual([{ theme: '完全自定义的主题', variation: 'match-9' }]);

    // The same passthrough preserves honest failures verbatim, still without touching the cache.
    script.push({ ok: false, reason: 'timeout', message: FAILURE_MESSAGES.timeout });
    expect(await generate({ theme: '另一个自定义主题', variation: 'match-10' })).toEqual({
      ok: false,
      reason: 'timeout',
      message: FAILURE_MESSAGES.timeout,
    });
    expect(await rowOf(db)).toBeNull();
    expect(script.calls).toHaveLength(2);
  });
});
