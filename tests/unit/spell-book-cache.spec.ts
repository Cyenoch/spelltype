/**
 * Shared spell-book cache behavior — the per-theme state machine that decides when a preset
 * theme costs a model call, who waits for it, and what a crash or failure costs.
 *
 * `ThemeBookCache` is the engine `SpellBookCache` delegates to; it takes its whole platform
 * surface (SQL, sync, clock, sleep, generation) as injected dependencies, so these tests drive
 * real SQLite through `tests/support/sql-storage.ts` with a scripted provider. No workerd, no
 * network — every freshness, lease, fencing and retry rule is asserted on what a caller of
 * `getSpellBook` can actually observe, including across a simulated isolate restart that reopens
 * the same durable SQLite file.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPELL_BOOK_SIZE, THEME_PRESETS, type Spell } from '../../shared/protocol';
import { BOOK_FRESH_MS, BOOK_LEASE_MS, ThemeBookCache } from '../../worker/generation/book-cache';
import { FAILURE_MESSAGES } from '../../worker/generation/spells';
import type { GenerationInput, GenerationOutcome } from '../../worker/generation/spells';
import { openFileTestStorage, openTestStorage, type TestStorage } from '../support/sql-storage';

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The scripted provider surface: recorded calls plus a queue of outcomes, in order. */
export interface GenerationScript {
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
  bookJson: string | null;
  publishedAt: number | null;
  token: string | null;
  leaseExpiresAt: number | null;
}

function rowOf(storage: TestStorage): CacheRowSnapshot | null {
  const rows = storage.sql
    .exec<{
      book_json: string | null;
      published_at: number | null;
      token: string | null;
      lease_expires_at: number | null;
    }>('SELECT book_json, published_at, token, lease_expires_at FROM spell_book_cache WHERE id = 1')
    .toArray();
  const row = rows[0];
  if (row === undefined) return null;
  return {
    bookJson: row.book_json,
    publishedAt: row.published_at,
    token: row.token,
    leaseExpiresAt: row.lease_expires_at,
  };
}

const storages: TestStorage[] = [];

/** An in-memory cache database, registered for close. */
function freshStorage(): TestStorage {
  const storage = openTestStorage();
  storages.push(storage);
  return storage;
}

/**
 * A cache with a fixed clock, a recorded sleep that advances it (as a real sleep would), and a
 * scripted provider. `sync` can be replaced to exercise storage failures around the refresh.
 */
function makeCache(
  storage: TestStorage,
  clock: Clock,
  script: GenerationScript,
  sync: () => Promise<void> = () => Promise.resolve(),
) {
  const sleeps: number[] = [];
  const cache = new ThemeBookCache({
    sql: storage.sql,
    sync,
    generate: (input) => script.generate(input),
    now: () => clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.now += ms;
    },
  });
  return { cache, sleeps };
}

/** Resolves once the durable lease row shows a claimed generation, returning its token. */
async function waitUntilClaimed(storage: TestStorage): Promise<string> {
  return vi.waitFor(() => {
    const token = rowOf(storage)?.token ?? null;
    if (token === null) throw new Error('generation was never claimed');
    return token;
  });
}

/** Lets every microtask the current callers scheduled run before assertions. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

interface RestartableStorage {
  storage: TestStorage;
  /** A second live handle on the same durable file, the way a restarted isolate would see it. */
  reopen: () => TestStorage;
}

const fileStorages: TestStorage[] = [];
const fileDirs: string[] = [];

function openRestartableStorage(): RestartableStorage {
  const dir = mkdtempSync(join(tmpdir(), 'spell-book-cache-'));
  fileDirs.push(dir);
  const path = join(dir, 'cache.sqlite');
  const storage = openFileTestStorage(path);
  fileStorages.push(storage);
  return {
    storage,
    reopen: () => {
      const reopened = openFileTestStorage(path);
      fileStorages.push(reopened);
      return reopened;
    },
  };
}

afterEach(() => {
  while (storages.length > 0) storages.pop()?.close();
  while (fileStorages.length > 0) fileStorages.pop()?.close();
  while (fileDirs.length > 0) {
    const dir = fileDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('共享咒语书缓存', () => {
  it('冷缓存首个请求生成并发布；五分钟内后续请求直接命中缓存，不再计费', async () => {
    const clock: Clock = { now: T0 };
    const storage = freshStorage();
    const script = scriptedGeneration();
    const bookA = book('A');
    script.push({ ok: true, spells: bookA, attempts: 1 });
    const { cache } = makeCache(storage, clock, script);

    expect(await cache.getSpellBook(THEME)).toEqual({ ok: true, spells: bookA });
    // The caller only sees the book once it is persisted and the lease is gone.
    const row = rowOf(storage);
    expect(row?.bookJson).not.toBeNull();
    expect(row?.publishedAt).toBe(T0);
    expect(row?.token).toBeNull();

    clock.now = T0 + BOOK_FRESH_MS - 1;
    expect(await cache.getSpellBook(THEME)).toEqual({ ok: true, spells: bookA });
    expect(script.calls).toHaveLength(1);
  });

  it('整整五分钟后新鲜期失效，下一次请求用新的刷新令牌按原主题重新生成', async () => {
    const clock: Clock = { now: T0 };
    const storage = freshStorage();
    const script = scriptedGeneration();
    script.push({ ok: true, spells: book('A'), attempts: 1 });
    const { cache } = makeCache(storage, clock, script);
    await cache.getSpellBook(THEME);

    clock.now = T0 + BOOK_FRESH_MS;
    const bookB = book('B');
    script.push({ ok: true, spells: bookB, attempts: 1 });
    expect(await cache.getSpellBook(THEME)).toEqual({ ok: true, spells: bookB });
    expect(script.calls).toHaveLength(2);
    expect(script.calls[0].theme).toBe(THEME);
    expect(script.calls[1].theme).toBe(THEME);
    // The refresh token doubles as the variation: two generations never share one.
    expect(script.calls[1].variation).not.toBe(script.calls[0].variation);
  });

  it('有旧书时并发刷新：首个请求等待新书，其他读者立即拿到旧书', async () => {
    const clock: Clock = { now: T0 };
    const storage = freshStorage();
    const script = scriptedGeneration();
    const firstBook = book('A');
    script.push({ ok: true, spells: firstBook, attempts: 1 });
    const { cache } = makeCache(storage, clock, script);
    await cache.getSpellBook(THEME);

    clock.now = T0 + BOOK_FRESH_MS + 1;
    const gate = deferred<GenerationOutcome>();
    script.push(gate.promise);
    const owner = cache.getSpellBook(THEME);
    await waitUntilClaimed(storage);

    const readerOutcome = await cache.getSpellBook(THEME);
    expect(readerOutcome).toEqual({ ok: true, spells: firstBook });
    expect(script.calls).toHaveLength(2);

    const secondBook = book('B');
    gate.resolve({ ok: true, spells: secondBook, attempts: 1 });
    expect(await owner).toEqual({ ok: true, spells: secondBook });
  });

  it('冷缓存并发请求合并为一次生成，所有等待者拿到同一结果', async () => {
    const clock: Clock = { now: T0 };
    const storage = freshStorage();
    const script = scriptedGeneration();
    const gate = deferred<GenerationOutcome>();
    script.push(gate.promise);
    const { cache } = makeCache(storage, clock, script);

    const first = cache.getSpellBook(THEME);
    await waitUntilClaimed(storage);
    const second = cache.getSpellBook(THEME);

    const bookA = book('A');
    gate.resolve({ ok: true, spells: bookA, attempts: 1 });
    const outcomes = await Promise.all([first, second]);
    expect(outcomes[0]).toEqual({ ok: true, spells: bookA });
    expect(outcomes[1]).toEqual({ ok: true, spells: bookA });
    expect(script.calls).toHaveLength(1);
  });

  it('进行中的生成比过期的租约优先：租约到期也不会发起第二次供应商调用', async () => {
    const clock: Clock = { now: T0 };
    const storage = freshStorage();
    const script = scriptedGeneration();
    const gate = deferred<GenerationOutcome>();
    script.push(gate.promise);
    const { cache } = makeCache(storage, clock, script);

    const first = cache.getSpellBook(THEME);
    await waitUntilClaimed(storage);
    // The claim precedes the generation budget, so the lease can lapse while the attempt lives.
    clock.now = T0 + BOOK_LEASE_MS + 1;
    const second = cache.getSpellBook(THEME);
    await flushMicrotasks();
    expect(script.calls).toHaveLength(1);

    const bookP = book('P');
    gate.resolve({ ok: true, spells: bookP, attempts: 1 });
    expect(await second).toEqual({ ok: true, spells: bookP });
    expect(await first).toEqual({ ok: true, spells: bookP });
    expect(script.calls).toHaveLength(1);
  });

  it('空缓存生成失败：如实失败并清除租约，下一个请求立即重试', async () => {
    const clock: Clock = { now: T0 };
    const storage = freshStorage();
    const script = scriptedGeneration();
    script.push({ ok: false, reason: 'upstream', message: FAILURE_MESSAGES.upstream });
    const { cache } = makeCache(storage, clock, script);

    expect(await cache.getSpellBook(THEME)).toEqual({
      ok: false,
      reason: 'upstream',
      message: FAILURE_MESSAGES.upstream,
    });
    const row = rowOf(storage);
    expect(row?.token).toBeNull();
    expect(row?.bookJson).toBeNull();

    const bookA = book('A');
    script.push({ ok: true, spells: bookA, attempts: 1 });
    expect(await cache.getSpellBook(THEME)).toEqual({ ok: true, spells: bookA });
    expect(script.calls).toHaveLength(2);
  });

  it('有旧书时刷新失败：发起者拿到旧书，发布时间不动，下一请求立即重试', async () => {
    const clock: Clock = { now: T0 };
    const storage = freshStorage();
    const script = scriptedGeneration();
    const oldBook = book('A');
    script.push({ ok: true, spells: oldBook, attempts: 1 });
    const { cache } = makeCache(storage, clock, script);
    await cache.getSpellBook(THEME);

    clock.now = T0 + BOOK_FRESH_MS + 1;
    script.push({ ok: false, reason: 'timeout', message: FAILURE_MESSAGES.timeout });
    expect(await cache.getSpellBook(THEME)).toEqual({ ok: true, spells: oldBook });
    const row = rowOf(storage);
    expect(row?.publishedAt).toBe(T0);
    expect(row?.token).toBeNull();

    const newBook = book('B');
    script.push({ ok: true, spells: newBook, attempts: 1 });
    expect(await cache.getSpellBook(THEME)).toEqual({ ok: true, spells: newBook });
    expect(script.calls).toHaveLength(3);
  });

  it('生成器抛出异常：如实转为失败、释放进行中的刷新，缓存随后仍可用', async () => {
    const clock: Clock = { now: T0 };
    const storage = freshStorage();
    const script = scriptedGeneration();
    script.push(Promise.reject(new Error('provider socket died')));
    const { cache } = makeCache(storage, clock, script);

    expect(await cache.getSpellBook(THEME)).toEqual({
      ok: false,
      reason: 'upstream',
      message: FAILURE_MESSAGES.upstream,
    });
    expect(rowOf(storage)?.token).toBeNull();

    const bookA = book('A');
    script.push({ ok: true, spells: bookA, attempts: 1 });
    expect(await cache.getSpellBook(THEME)).toEqual({ ok: true, spells: bookA });
  });

  it('发布后的存储同步失败：等待者收到失败而不是未持久化的成功', async () => {
    const clock: Clock = { now: T0 };
    const storage = freshStorage();
    const script = scriptedGeneration();
    const gate = deferred<GenerationOutcome>();
    script.push(gate.promise);
    let syncCalls = 0;
    const { cache } = makeCache(storage, clock, script, async () => {
      syncCalls += 1;
      if (syncCalls === 2) throw new Error('storage unavailable');
    });

    const owner = cache.getSpellBook(THEME);
    await waitUntilClaimed(storage);
    const follower = cache.getSpellBook(THEME);

    const bookA = book('A');
    gate.resolve({ ok: true, spells: bookA, attempts: 1 });
    await expect(owner).rejects.toThrow('storage unavailable');
    await expect(follower).rejects.toThrow('storage unavailable');
    expect(script.calls).toHaveLength(1);
  });

  it('非预设主题直接拒绝，不发起任何模型调用', async () => {
    const clock: Clock = { now: T0 };
    const storage = freshStorage();
    const script = scriptedGeneration();
    const { cache } = makeCache(storage, clock, script);

    await expect(cache.getSpellBook('完全自定义的主题')).rejects.toThrow();
    expect(script.calls).toHaveLength(0);
  });

  it('崩溃后的空缓存：等满剩余租约再由该请求恢复，迟到的旧结果被挡在新书之外', async () => {
    const { storage, reopen } = openRestartableStorage();
    const clock: Clock = { now: T0 };

    const crashed = deferred<GenerationOutcome>();
    const crashedScript = scriptedGeneration();
    crashedScript.push(crashed.promise);
    const before = makeCache(storage, clock, crashedScript);
    const crashedCall = before.cache.getSpellBook(THEME);
    await waitUntilClaimed(storage);

    // The isolate dies mid-generation and comes back with the lease still on disk.
    const restartAt = T0 + Math.floor(BOOK_LEASE_MS / 2);
    clock.now = restartAt;
    const recoveredBook = book('R');
    const recoveryScript = scriptedGeneration();
    recoveryScript.push({ ok: true, spells: recoveredBook, attempts: 1 });
    const after = makeCache(reopen(), clock, recoveryScript);

    expect(await after.cache.getSpellBook(THEME)).toEqual({ ok: true, spells: recoveredBook });
    expect(after.sleeps).toEqual([T0 + BOOK_LEASE_MS - restartAt]);
    expect(recoveryScript.calls).toHaveLength(1);

    // The crashed attempt's late success must not overwrite the newer generation.
    crashed.resolve({ ok: true, spells: book('C'), attempts: 1 });
    expect(await crashedCall).toEqual({ ok: true, spells: recoveredBook });
    const row = rowOf(storage);
    expect(JSON.parse(row?.bookJson ?? '""')).toEqual(recoveredBook);
    expect(row?.token).toBeNull();
    expect(crashedScript.calls).toHaveLength(1);
    expect(recoveryScript.calls).toHaveLength(1);
  });

  it('崩溃期间旧书仍在：读者立即拿到旧书，不等待也不重新计费', async () => {
    const { storage, reopen } = openRestartableStorage();
    const clock: Clock = { now: T0 };

    const seedScript = scriptedGeneration();
    const oldBook = book('A');
    seedScript.push({ ok: true, spells: oldBook, attempts: 1 });
    const seed = makeCache(storage, clock, seedScript);
    await seed.cache.getSpellBook(THEME);

    clock.now = T0 + BOOK_FRESH_MS + 1;
    const stalled = deferred<GenerationOutcome>();
    const crashedScript = scriptedGeneration();
    crashedScript.push(stalled.promise);
    const crashed = makeCache(storage, clock, crashedScript);
    void crashed.cache.getSpellBook(THEME).catch(() => undefined);
    await waitUntilClaimed(storage);

    const restartedScript = scriptedGeneration();
    const restarted = makeCache(reopen(), clock, restartedScript);
    expect(await restarted.cache.getSpellBook(THEME)).toEqual({ ok: true, spells: oldBook });
    expect(restarted.sleeps).toEqual([]);
    expect(restartedScript.calls).toHaveLength(0);
  });

  it('每个主题各自独立缓存：一个主题的租约不会拖慢另一个主题', async () => {
    const clock: Clock = { now: T0 };
    const storageA = freshStorage();
    const storageB = freshStorage();

    const gate = deferred<GenerationOutcome>();
    const scriptA = scriptedGeneration();
    scriptA.push(gate.promise);
    const sideA = makeCache(storageA, clock, scriptA);
    void sideA.cache.getSpellBook(THEME).catch(() => undefined);
    await waitUntilClaimed(storageA);

    const bookB = book('B');
    const scriptB = scriptedGeneration();
    scriptB.push({ ok: true, spells: bookB, attempts: 1 });
    const sideB = makeCache(storageB, clock, scriptB);
    expect(await sideB.cache.getSpellBook(OTHER_THEME)).toEqual({ ok: true, spells: bookB });
    expect(sideB.sleeps).toEqual([]);
    expect(scriptB.calls).toHaveLength(1);
  });
});
