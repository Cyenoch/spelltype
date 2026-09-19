/**
 * 共享法术书缓存行为 —— 针对每个预设主题的状态机，用于决定何时预设主题需要消耗一次模型调用、
 * 谁需要等待它，以及进程崩溃或生成失败会带来什么成本。
 *
 * `createSpellBookGenerator` 是服务端组装的完整实现，因此这些测试驱动真实的 PGlite 数据库
 * （真实的生产打开路径、真实的 Drizzle 数据库迁移），配合脚本化的提供者和固定的时钟运行。
 * 无需真实网络 —— 所有的保鲜期、租约、围栏和重试规则，均基于包装生成器的调用方实际可观察到的行为进行断言，
 * 涵盖了重新打开同一 PGlite 数据目录的模拟进程重启，以及如同两个服务端进程那样共享同一数据库的两个独立生成器实例。
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

/** ASCII 伪词的精确长度码点序列，每个 offset 均不同。 */
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

/** 一本符合规范的咒文书；`flavor` 使不同代际生成的书彼此可区分。 */
function book(flavor: string): Spell[] {
  return Array.from({ length: SPELL_BOOK_SIZE }, (_, index) => ({
    name: `${NAME_BASES[index % NAME_BASES.length]} ${LETTERS[index % LETTERS.length].toUpperCase()}${flavor}`,
    text: wordRun(27, index),
    translation: `${ZH_BASES[index % ZH_BASES.length]}，第 ${index + 1} 条。`,
    element: (['arcane', 'fire', 'ice', 'storm'] as const)[index % 4],
  }));
}

/** 脚本化供应商接口：按顺序记录调用并给出预设结果队列。 */
interface GenerationScript {
  readonly calls: GenerationInput[];
  push(next: GenerationOutcome | Promise<GenerationOutcome>): void;
  generate(input: GenerationInput): Promise<GenerationOutcome>;
}

/** 记录每一次生成输入，并按顺序分发脚本化结果。 */
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

/** 基于真实打开路径的临时内存缓存数据库，已注册以便测试结束后关闭。 */
async function freshDatabase(): Promise<Database> {
  const opened = await openDatabase('pglite://:memory:');
  openDatabases.push(opened);
  return opened.db;
}

/**
 * 带有固定时钟和记录推进休眠的缓存生成器（模拟真实休眠的时钟推进）。
 * 自定义的 `sleep` 可在记录之上添加额外行为 —— 例如在闸门打开前拦住重新检查的读者 —— 同时时钟仍如真实休眠般前进。
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

/** 当持久化租约行显示已认领生成时 resolve，并返回其令牌。 */
async function waitUntilClaimed(db: Database, theme: string = THEME): Promise<string> {
  for (let poll = 0; poll < 2_000; poll += 1) {
    const token = (await rowOf(db, theme))?.token ?? null;
    if (token !== null) return token;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('generation was never claimed');
}

/** 运行等待结果并断言其抛出存储错误，而不是虚假结果。 */
async function rejectsWithStorageFailure(run: Promise<GenerationOutcome>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('expected the refresh to reject instead of reporting an unpersisted outcome');
}

/** 在执行断言之前，让当前调用方调度的所有微任务全部执行完毕。 */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
}

interface RestartableDatabase {
  db: Database;
  /** 同一持久化数据目录的第二个活动句柄，模拟重启后进程所看到的状态。 */
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
    // 调用方只有在法术书已持久化且租约已清除后才能看到法术书。
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
    // 刷新令牌同时充当变体（variation）：两次生成决不共享同一变体。
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
    // 认领先于生成预算发生，因此在尝试存活期间租约可能先到期。
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
    // 存储在结果能够发布之前关闭：任何调用方都绝不能看到未持久化的法术书。
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

    // 崩溃的尝试永远不会 settle：其进程已彻底消失。
    const crashedScript = scriptedGeneration();
    crashedScript.push(Promise.withResolvers<GenerationOutcome>().promise);
    const before = makeCache(restartable.db, clock, crashedScript);
    void before.generate({ theme: THEME, variation: 'match-1' }).catch(() => undefined);
    await waitUntilClaimed(restartable.db);

    // 进程在生成中途崩溃，并在租约仍在磁盘上时恢复。
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
    // 剩余租约是通过有界的周期性重查度过的，绝非一次性睡满整个窗口。
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

    // 卡住的生成持有着租约，随后超过整个预算彻底无响应 ——
    // 这正是另一个进程必须能够接管并从中恢复的死锁状态。
    const stalled = Promise.withResolvers<GenerationOutcome>();
    const staleScript = scriptedGeneration();
    staleScript.push(stalled.promise);
    const stale = makeCache(db, clock, staleScript);
    const staleCall = stale.generate({ theme: THEME, variation: 'match-1' });
    await waitUntilClaimed(db);
    clock.now = T0 + BOOK_LEASE_MS + 1;

    // 第二个实例接管过期的租约并发布较新的生成结果。
    const recoveredBook = book('R');
    const recoveryScript = scriptedGeneration();
    recoveryScript.push({ ok: true, spells: recoveredBook, attempts: 1 });
    const recovery = makeCache(db, clock, recoveryScript);
    expect(await recovery.generate({ theme: THEME, variation: 'match-2' })).toEqual({
      ok: true,
      spells: recoveredBook,
      attempts: 0,
    });

    // 迟到结果的令牌已被取代：它什么也不发布、什么也不清除，
    // 已结算的持有者返回持久化的当前法术书 —— 绝不返回其自身未持久化的结果。
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
    // PGlite 会串行化这些真实查询；此次读取在跟随者的缓存读取之后进行。
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

    // “另一个进程”持有租约：同一数据库上的一个独立生成器实例。
    const gate = Promise.withResolvers<GenerationOutcome>();
    const ownerScript = scriptedGeneration();
    ownerScript.push(gate.promise);
    const owner = makeCache(db, clock, ownerScript);
    const ownerCall = owner.generate({ theme: THEME, variation: 'match-1' });
    await waitUntilClaimed(db);

    // 第二个实例上的冷读取方进行重查；其首次唤醒等待直到持有者真正发布，使下方的断言具有确定性。
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
    // 仅一次有界重查 —— 而非等待全部剩余租约时间 —— 读者就拿到了法术书。
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
    // 空脚本：如果第二个实例向供应商发起了计费调用，本测试将立即报错失败。
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
    // 恰好一次供应商调用：第二个实例观察到了第一个实例的租约及其随后的发布，而不是针对同一冷门主题重复计费。
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

    // 同样的直通透传机制完整保留真实的失败，依然不触碰缓存。
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
