import { and, eq } from 'drizzle-orm';
import { THEME_PRESETS, type Spell } from '../../shared/protocol';
import type { GenerateSpells } from '../contracts';
import type { Database, QueryDatabase } from '../db';
import { spellBookCache } from '../db/schema';
import { FAILURE_MESSAGES, GENERATION_BUDGET_MS } from './spells';
import type { GenerationFailure, GenerationInput, GenerationOutcome } from './spells';

/**
 * 每个主题共享本预设法术书。在行锁保护下校验新鲜度后进行租约申领；
 * 结果发布与失败清理均通过令牌围栏进行条件更新。调用大模型的耗时操作均在事务之外执行。
 */

/**
 * 共享法术书请求的产物：一份校验通过的缓存法术书，或直接生成时所产生的同样诚实且可明确区分的失败结果。
 * 绝不存在虚假法术书，或将陈旧内容谎标为新鲜法术书。
 */
export type SpellBookOutcome = { ok: true; spells: Spell[] } | GenerationFailure;

/**
 * 仅成功发布才能赢得新鲜度：法术书入库后的该时间段内，所有到期的请求均由缓存直接提供服务，
 * 期间不产生任何模型调用计费。失败的尝试绝不会设定或延长该时间窗口，也绝不阻碍后续请求发起重试。
 */
export const BOOK_FRESH_MS = 5 * 60_000;

/**
 * 持久化的处理中租约时长恰好覆盖自申领起最坏情况下的单次生成用时。
 * 这是用于崩溃防范的保护机制：在生成过程中途发生重启后，下一个到期的请求会等待完剩余的时间窗口，
 * 然后才启动恢复流程，从而避免立即再次踏入死掉尝试的计费窗口。
 * 这是一种保守的延迟等待——并不保证上游调用没有以某种方式仍在运行，也并非失败冷却期：
 * 已结算的尝试会主动清除其自身的租约，因此刷新失败后的下一次请求可以立即重试。
 */
export const BOOK_LEASE_MS = GENERATION_BUDGET_MS;

/**
 * 冷启动读取方重新检查非自身持有租约的轮询频率。租约归属于另一个进程
 * （每次状态转换均为数据库语句，故无跨进程共享内存可供查询），且该所有者随时可能发布结果：
 * 以有界步长定期重检，能在该节奏内迅速感知新发布的法术书，无需被动等待完整个剩余租约窗口。
 */
export const BOOK_LEASE_RECHECK_MS = 250;

/** 单个主题缓存的数据行结构：已发布的法术书、发布时间以及任何存活的租约。 */
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
    // 数据库中存储的法术书若非数组，则按空缓存处理，避免读取路径直接报错崩溃。
    book: Array.isArray(row.book) ? row.book : null,
    publishedAt: row.published_at,
    token: row.token,
    leaseExpiresAt: row.lease_expires_at,
  };
}

/**
 * 在主题行锁保护下重新检查解码后的法术书与存活租约。发布者可能在调用方首次读取之后刚好完成；
 * 该发布必须阻止第二次产生费用的重复生成。该事务在任何模型提供商调用开始前提交其租约申领。
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

/** 发布法术书及最新的发布时间，并清除租约——仅当匹配当前持有令牌时生效。 */
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

/** 确定的失败仅清除租约；法术书及其发布时间保持不变。 */
async function clearLease(database: QueryDatabase, theme: string, token: string): Promise<void> {
  await database
    .update(spellBookCache)
    .set({ token: null, lease_expires_at: null })
    .where(and(eq(spellBookCache.theme, theme), eq(spellBookCache.token, token)));
}

/** 狭义的时间/睡眠插桩接口，以便测试可以在固定时钟下驱动真实数据库。 */
export interface ThemeBookCacheOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 单个主题进行中的刷新任务，在内存中共享，使冷读取方能合并等待而非重复计费。 */
interface Pending {
  token: string;
  promise: Promise<SpellBookOutcome>;
}

/**
 * 面向 THEME_PRESETS 预设主题的共享法术书管理：每个主题对应一行数据库记录，每个进程持有一个单例。
 * 规则按先后顺序执行：
 *
 * 1. 当前进程内正在运行的尝试在其执行期间始终具有权威性——无论其租约是否已经失效，因为申领在生成预算开始前就已写入，
 *    且仅在该行仍携带对应令牌时有效。旧法术书读取方立即可获得当前法术书；冷缓存则合并到这单次进行中的刷新中，
 *    并观察其实际的最终结果（成功或被拒收）。
 * 2. 仅当本地没有已知的存活尝试时，该行的租约才代表远程所有者——另一个进程，或重启后遗失的进程。
 *    旧法术书仍可立即提供服务；冷缓存以有界步长重新检查，以便及时提供所有者发布的内容，
 *    且在启动恢复流程前仅等待失效租约的剩余窗口。
 * 3. 在 BOOK_FRESH_MS 之内发布的法术书原样提供服务；不产生模型调用计费。
 * 4. 否则——数据为空或已过期，且无存活的尝试——当前请求独占拥有恰好一次刷新机会：在行锁保护下重新核验新鲜度后申领租约
 *    （竞态中落败方将重新读取而非重复计费），执行单次生成（生成器内部自身的有界重试策略依然适用），
 *    成功时发布，失败时清除租约。已定论的失败之后到来的下一个请求可以立即重试；不存在失败惩罚冷却期。
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
   * 共享入口。仅支持缓存 THEME_PRESETS 预设主题——预设行以精确修剪后的主题字符串为键，
   * 自定义主题则由调用方按场次单独生成。在此传入非预设主题属于违反内部协议，因此会在不调用模型的情况下显式报错；
   * `createSpellBookGenerator` 会将自定义主题绕过本类直接路由。
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
          // 租约属于远程或失联的所有者：旧法术书依然立即可用，
          // 冷缓存则以有界步长定期重检——所有者的发布将在下一次读取时显现，而非等待完整个剩余窗口。
          if (state.book !== null) return { ok: true, spells: state.book };
          const waitingFor = state.token;
          await this.sleep(Math.min(BOOK_LEASE_RECHECK_MS, state.leaseExpiresAt - now));
          state = await readRow(this.database, theme);
          // 该次尝试已结束或被取代且未发布成功。不要为当前等待者静默计费发起第二次尝试；
          // 新请求可以自行申领此时已清空的缓存。
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

      // 内容为空或过期且无存活尝试：当前请求拥有恰好一次刷新权限。
      // 申领租约仍可能输给率先判定同一行的并发进程；此时该行持有崭新的外部租约，上述循环将重新决策。
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
   * 单次端到端完整刷新：持久化申领、生成一次、发布或清除，随后上报结果。
   * 此处返回的 Promise 即为所有冷合并等待者所 await 的同一个对象，确保它们看到的与当前调用方完全一致——
   * 包括导致整个刷新被拒绝的数据库故障。
   */
  private async refresh(theme: string, token: string): Promise<SpellBookOutcome> {
    // 申领操作已经提交（调用方在调用前已 await 完成），因此此处若崩溃不会丢失租约，
    // 且模型调用绝不在任何数据库锁的保护范围之内运行。
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

    // 每次流转均为单条带守卫条件的 SQL 语句：被取代的过期令牌产生的迟到结果既不发布也不清除任何内容，
    // 确保其绝不会覆盖更新的生成——并将其作为失败上报，绝不会未持久化便提供服务。
    if (outcome.ok) {
      const published = await publishBook(this.database, theme, token, outcome.spells, this.now());
      if (!published) {
        outcome = { ok: false, reason: 'upstream', message: FAILURE_MESSAGES.upstream };
      }
    } else {
      await clearLease(this.database, theme, token);
    }

    const latest = await readRow(this.database, theme);
    // 无论成功还是失败，只要存在旧法术书，已定论的所有者均会共享旧书——
    // 只有在缓存完全未命中（冷启动）时才会获得显式失败，与直接按场次生成完全一致。
    if (latest.book !== null) return { ok: true, spells: latest.book };
    return outcome;
  }
}

/**
 * 生产环境组合函数：包装一个 `GenerateSpells`（`startServer` 根据配置的模型服务构建的按场次生成器，或注入的测试夹具），
 * 使得属于 THEME_PRESETS 的主题走共享缓存，其余所有主题原样透传——自定义主题保持按场次生成并携带调用方自有的变体种子。
 *
 * 由已存储缓存状态命中的成功请求会报告 `attempts: 0`：因为该响应属于缓存命中，
 * 提供商成本已由执行刷新的那一次请求支付过——调用方从缓存获得的结果从不宣称自己消耗了尝试次数。
 * 直接生成（自定义主题）则原样透传底层的生成结果。
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
