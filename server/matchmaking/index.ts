import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, ne } from 'drizzle-orm';
import type { Phase } from '../../shared/protocol';
import {
  QUEUE_ENTRY_TTL_MS,
  QUICK_GHOST_FALLBACK_MS,
  RESERVATION_TTL_MS,
  THEME_PRESETS,
} from '../../shared/protocol';
import type { MatchCancelResult, MatchTicket, User } from '../../shared/protocol';
import { assertAdmission } from '../maintenance/control';
import type { Database, QueryDatabase, Transaction } from '../db';
import {
  departures,
  matchTickets,
  players,
  rooms,
  type RoomRow,
  type TicketRow,
} from '../db/schema';
import { chooseGhost } from '../ghosts';
import { createRoom, updateRoom } from '../rooms/storage/room';

/**
 * 基于同一共享数据库的撮合匹配机制。
 *
 * 通过 `match_tickets.user_id` 主键强制保证每个账户全局仅占有一个席位。等待中的数据行构成
 * 单个共享队列；已匹配行标识已预留或正在对局中的席位。配对操作在单个事务内原子提交房间、双方玩家及双方票据。
 *
 * 状态保真规则：
 * - 仅当能证实账户既无有效票据亦无存活席位时，`cancelled` 才为 `true`。已开始的比赛将保留其席位并返回 `false`；
 *   取消预留配对中的一方会同时释放*双方*的席位与票据，以便留存的另一方账户能够立即重新排队。
 * - 已匹配票据的状态追随其房间而非物理时钟：只要预留仍存活或比赛仍在进行（且当前账户尚未退出），票据就持续保留，
 *   并在证实其席位彻底消失的瞬间被删除。等待中的票据仅通过轮询刷新 TTL，别无其他刷新途径。
 * - 维护模式：在服务器排空期间，已匹配的席位保持可读（且可玩）；取消操作亦可正常执行。
 *   新的排队请求与新的配对操作在各自的事务中从 `runtime_control` 读取持久化准入状态——`assertAdmission`
 *   首先对控制行加共享锁，确保在排空开始后绝无等待票据或配对房间能成功提交。
 *   失效席位票据的移除提交在无准入限制的独立事务中，因此准入拒绝绝不会回滚该清理操作。
 * - 虚拟对手回退保底：独处等待的账户若其排队条目自（重新）入队起已等待达 `QUICK_GHOST_FALLBACK_MS`，
 *   将被匹配给虚拟对手——但这仅发生在尝试寻找真实玩家之后，且绝不会在仍有其他有效等待票据供下次轮询配对时发生。
 *   优先匹配合格的已录制重影（ghost）；若无可用重影，则回退为生成的机器人。
 *   无论哪种方式，均通过单个事务创建房间、安排虚拟对手（`synthetic:<roomId>`，对外显示为 `Ghost / 训练法师`，
 *   创建即入座且就绪，无席位倒计时限制），并仅消费人类玩家的票据（转为该房间的已匹配席位）。
 *   虚拟对手方不持有账户、会话或票据，因此“每账户全局单一席位”的不变量及上述所有栅障均保持完好。
 *   排队记录的 `created_at` 即为其首次到达时间：TTL 刷新绝不会推进它，而刷新已过期的记录视作全新到达，
 *   确保复活的票据无法跳过等待真实对手的时间窗口。
 * - 加锁顺序：首先是 runtime_control（所有权栅障，其后为准入），接着是房间，最后是票据；
 *   当事务涉及多张票据时，按 `user_id` 升序依次加锁。此处任何事务内部均不等待网络操作。
 */

/** 正在进行中的对局阶段，此时比赛拥有席位，绝不可释放预留。 */
const MATCH_ACTIVE: Record<Phase, boolean> = {
  lobby: false,
  generating: true,
  countdown: true,
  playing: true,
  finished: false,
};

/** 有界重读次数：每一轮重试紧跟在并发请求可能先行变更的决策之后。 */
const PASSES = 3;

/** 虚拟对手的显示名称。绝不映射到任何账户、会话或票据。 */
const SYNTHETIC_OPPONENT_NAME = 'Ghost / 训练法师';

/** 虚拟席位 ID，派生自其房间 ID，确保在无后台账户的情况下全局唯一。 */
const syntheticSeatId = (roomId: string): string => `synthetic:${roomId}`;

/** 轮询到达但对应的请求已不复存在：该账户已在底层被取消。 */
export class MatchRejection extends Error {
  readonly status = 409;
  readonly userMessage: string;
  readonly error: string;

  constructor() {
    super('匹配已取消，请重新发起匹配');
    this.name = 'MatchRejection';
    this.userMessage = this.error = '匹配已取消，请重新发起匹配';
  }
}

export type MatchCancelOutcome = MatchCancelResult & {
  /** 本次取消所释放了预留的房间 ID；调用方据此刷新该房间的运行时。 */
  roomId: string | null;
};

/** 房间标识：使用安全随机数生成器生成的 24 位小写十六进制字符串。 */
export function newRoomId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

/**
 * 单次匹配轮询：返回现有的已匹配席位、加入（或保留在）共享队列、刷新等待条目的 TTL、
 * 与等待时间最长的另一账户配对；或者——当等待条目已超过回退时限且无存活真实对手时——
 * 为其分配虚拟对手（有合格重影时使用重播重影，否则使用生成的机器人）。
 * 进入队列的准入机制是持久化的：拒绝与放行的读取均在创建或延长队列状态的事务内部进行，
 * 确保轮询绝无法签发已被排空维护关闭的排队记录。
 *
 * `assertOwnership` 是运行时写入栅障（租约持有者的身份证明），在所有变更事务的第一步执行：
 * 丢失租约的进程在后继者接管后，绝不能再写入票据、释放席位或配对房间。
 */
export async function acquireMatch(
  database: Database,
  user: User,
  assertOwnership: (tx: Transaction) => Promise<void>,
): Promise<MatchTicket> {
  // 优先在无准入限制下返回已匹配席位：在服务器排空期间它保持可读——且可玩。
  // 失效席位的票据在此处删除并提交，使得下方的准入拒绝绝不会回滚该清理。
  for (let pass = 0; pass < PASSES; pass += 1) {
    const standing = await inspectStanding(database, user, assertOwnership);
    if (standing === 'retry') continue;
    if (standing.kind === 'matched') return standing.ticket;
    break; // `gone`（清理已提交）或 `queue`：重新入队需要持久化准入检查。
  }
  for (let pass = 0; pass < PASSES; pass += 1) {
    const step = await refreshWaiting(database, user, assertOwnership);
    if (step === 'retry') continue;
    if (step.pair) {
      const paired = await attemptPairing(database, user, assertOwnership);
      if (paired) return paired;
      // 无存活真人可配对：超过回退截止时间的独处等待者将获得重影对手——
      // 或在无合格重影时分配生成的机器人。
      const synthetic = await assignSyntheticPartner(database, user, assertOwnership);
      if (synthetic) return synthetic;
    }
    return step.ticket;
  }
  // 所有重试轮次中数据行均发生并发变动：以当前最新状态为准返回，绝不凭空创建请求。
  const current = await readTicket(database, user.id);
  if (!current) throw new MatchRejection();
  if (current.state === 'matched') return matchedTicketOf(current);
  return { state: 'waiting', expiresAt: current.expires_at };
}

/**
 * 取消该账户的匹配请求。返回结果符合 HTTP 层向外透传的契约：
 * 仅当已开始的比赛证实仍持有该席位时 `cancelled` 才为 `false`，并携带其释放的预留的 `roomId`，
 * 以便调用方刷新该房间的运行时。取消操作不消耗准入权限：在服务器排空维护期间依然可用。
 *
 * 由于取消操作会发生变更（释放票据并销毁预留配对的房间行与席位），因此必须调用 `assertOwnership`。
 * 失去租约的进程会在栅障处停下（位于任何房间或票据锁之前），避免在后继者的状态之下发生篡改重写。
 */
export async function cancelMatch(
  database: Database,
  userId: string,
  assertOwnership: (tx: Transaction) => Promise<void>,
): Promise<MatchCancelOutcome> {
  for (let pass = 0; pass < PASSES; pass += 1) {
    const outcome = await database.transaction(
      async (tx): Promise<MatchCancelOutcome | 'retry'> => {
        await assertOwnership(tx);
        const peek = await readTicket(tx, userId);
        if (!peek) return { cancelled: true, roomId: null };
        if (peek.state === 'waiting') {
          const current = await lockTicket(tx, userId);
          if (!current) return { cancelled: true, roomId: null };
          if (current.state !== 'waiting') return 'retry';
          await tx.delete(matchTickets).where(eq(matchTickets.user_id, userId));
          return { cancelled: true, roomId: null };
        }

        const roomId = peek.room_id;
        if (!roomId) {
          // 已匹配但没有关联房间的行无法持有任何席位：损坏的状态应当释放而非保留。
          const current = await lockTicket(tx, userId);
          if (!current || current.state !== 'matched') return 'retry';
          await tx.delete(matchTickets).where(eq(matchTickets.user_id, userId));
          return { cancelled: true, roomId: null };
        }
        const room = await lockRoom(tx, roomId);
        const current = await lockTicket(tx, userId);
        if (!current || current.state !== 'matched' || current.room_id !== roomId) return 'retry';
        if (!room) {
          await tx.delete(matchTickets).where(eq(matchTickets.user_id, userId));
          return { cancelled: true, roomId: null };
        }

        if (MATCH_ACTIVE[room.phase]) {
          const freed = await seatReleasedByDeparture(tx, room, userId);
          if (!freed) return { cancelled: false, roomId };
          await tx.delete(matchTickets).where(eq(matchTickets.user_id, userId));
          return { cancelled: true, roomId: null };
        }
        if (room.mode !== 'quick' || room.reservation_state !== 'reserved') {
          // 预留已不存在（已取消、已过期）或者该房间从未存在预留。
          await tx.delete(matchTickets).where(eq(matchTickets.user_id, userId));
          return { cancelled: true, roomId: null };
        }
        await cancelReservedPairing(tx, room, Date.now());
        return { cancelled: true, roomId };
      },
    );
    if (outcome !== 'retry') return outcome;
  }
  // 重试轮次耗尽：执行最后一次保守的兜底事务。真正删除仍处于等待中的记录；
  // 已匹配的记录则在不进行变更的情况下如实应答——只要比赛可能仍持有席位，`cancelled: false` 就是最诚实的回答。
  return database.transaction(async (tx): Promise<MatchCancelOutcome> => {
    await assertOwnership(tx);
    const current = await lockTicket(tx, userId);
    if (!current) return { cancelled: true, roomId: null };
    if (current.state === 'waiting') {
      await tx.delete(matchTickets).where(eq(matchTickets.user_id, userId));
      return { cancelled: true, roomId: null };
    }
    return { cancelled: false, roomId: current.room_id ?? null };
  });
}

// ------------------------------------------------------------- 已匹配席位状态判定

/** 无准入限制的首个事务针对该账户已匹配席位所探测到的状态。 */

type Standing =
  | { kind: 'matched'; ticket: MatchTicket }
  | { kind: 'gone' }
  | { kind: 'queue' }
  | 'retry';

/**
 * 在不触发准入检查的前提下读取账户的已匹配席位，并释放已被证实失效的席位。
 * 将清理操作在此处独立提交——与下方受准入管控的重新入队解耦——确保维护拒绝不会复活失效席位的票据。
 * 写入栅障最先执行：释放失效席位的票据与其他操作一样属于状态变更，停机交权的所有者不得执行任何变更。
 */
async function inspectStanding(
  database: Database,
  user: User,
  assertOwnership: (tx: Transaction) => Promise<void>,
): Promise<Standing> {
  return database.transaction(async (tx): Promise<Standing> => {
    await assertOwnership(tx);
    const peek = await readTicket(tx, user.id);
    if (!peek) return { kind: 'queue' };
    if (peek.state !== 'matched') return { kind: 'queue' };

    const roomId = peek.room_id;
    if (!roomId) {
      // 已匹配但没有关联房间的行无法持有任何席位：损坏的状态应当释放而非保留。
      const current = await lockTicket(tx, user.id);
      if (!current || current.state !== 'matched') return 'retry';
      await tx.delete(matchTickets).where(eq(matchTickets.user_id, user.id));
      return { kind: 'gone' };
    }
    const room = await lockRoom(tx, roomId);
    const current = await lockTicket(tx, user.id);
    if (!current || current.state !== 'matched' || current.room_id !== roomId) return 'retry';
    if (!room || !(await seatHeld(tx, room, user.id))) {
      await tx.delete(matchTickets).where(eq(matchTickets.user_id, user.id));
      return { kind: 'gone' };
    }
    return { kind: 'matched', ticket: matchedTicketOf(current) };
  });
}

function matchedTicketOf(row: TicketRow): MatchTicket {
  return {
    state: 'matched',
    roomId: row.room_id ?? undefined,
    expiresAt: row.expires_at,
  };
}

// ------------------------------------------------------------------------- 队列加入 / 刷新

/**
 * 单次受准入管控的队列操作：刷新等待记录的 TTL 或创建新记录。
 * 写入栅障与准入读取依序作为事务的前两条语句执行；其前没有任何持久化操作，
 * 因而排空拒绝不会回滚任何数据——失效席位的清理（若有）已经在 `inspectStanding` 中完成提交。
 */

type JoinStep = { ticket: MatchTicket; pair: boolean } | 'retry';

async function refreshWaiting(
  database: Database,
  user: User,
  assertOwnership: (tx: Transaction) => Promise<void>,
): Promise<JoinStep> {
  return database.transaction(async (tx): Promise<JoinStep> => {
    await assertOwnership(tx);
    await assertAdmission(tx);
    const now = Date.now();
    const peek = await readTicket(tx, user.id);

    if (peek?.state === 'matched') {
      // 在两个事务间隙，该账户的并发轮询赢得了席位：直接以该席位应答。
      const roomId = peek.room_id;
      if (!roomId) {
        const current = await lockTicket(tx, user.id);
        if (!current || current.state !== 'matched') return 'retry';
        await tx.delete(matchTickets).where(eq(matchTickets.user_id, user.id));
        return insertWaiting(tx, user, now);
      }
      const room = await lockRoom(tx, roomId);
      const current = await lockTicket(tx, user.id);
      if (!current || current.state !== 'matched' || current.room_id !== roomId) return 'retry';
      if (room && (await seatHeld(tx, room, user.id))) {
        return { ticket: matchedTicketOf(current), pair: false };
      }
      // 席位在此时间窗口内失效；上方的准入检查依然作为重新入队的有效依据。
      await tx.delete(matchTickets).where(eq(matchTickets.user_id, user.id));
      return insertWaiting(tx, user, now);
    }

    if (peek?.state === 'waiting') {
      const current = await lockTicket(tx, user.id);
      if (!current) return 'retry';
      if (current.state !== 'waiting') return 'retry';
      const expiresAt = now + QUEUE_ENTRY_TTL_MS;
      await tx
        .update(matchTickets)
        .set({
          username: user.username,
          expires_at: expiresAt,
          // 存活的记录保留其原始到达时间：重复轮询绝不能重置重影截止时间所度量的已等待时长。
          // 已过期的记录视作离开队列，故其刷新作为全新到达——复活的票据不能继承旧的等待时间而跳过真人对手窗口。
          created_at: current.expires_at <= now ? now : current.created_at,
          updated_at: now,
        })
        .where(eq(matchTickets.user_id, user.id));
      return { ticket: { state: 'waiting', expiresAt }, pair: true };
    }

    return insertWaiting(tx, user, now);
  });
}

async function insertWaiting(tx: Transaction, user: User, now: number): Promise<JoinStep> {
  const requestId = randomUUID();
  const expiresAt = now + QUEUE_ENTRY_TTL_MS;
  // 主键兼作占位检查，且插入操作绝不覆盖：在此事务的快照与插入操作之间，
  // 该账户的并发轮询可能已创建了票据（或赢得了席位），该行记录——而非当前请求——拥有最终决定权。
  const [inserted] = await tx
    .insert(matchTickets)
    .values({
      user_id: user.id,
      request_id: requestId,
      username: user.username,
      state: 'waiting',
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { ticket: { state: 'waiting', expiresAt }, pair: true };

  const existing = await lockTicket(tx, user.id);
  if (!existing) return 'retry';
  if (existing.state === 'matched') {
    return { ticket: matchedTicketOf(existing), pair: false };
  }
  const expires = Math.max(existing.expires_at, now + QUEUE_ENTRY_TTL_MS);
  await tx
    .update(matchTickets)
    .set({ username: user.username, expires_at: expires, updated_at: now })
    .where(eq(matchTickets.user_id, user.id));
  return { ticket: { state: 'waiting', expiresAt: expires }, pair: true };
}

// ----------------------------------------------------------------------------- 配对

async function attemptPairing(
  database: Database,
  user: User,
  assertOwnership: (tx: Transaction) => Promise<void>,
): Promise<MatchTicket | null> {
  return database.transaction(async (tx) => {
    // 栅障第一，准入第二——均在 runtime_control 上执行，早于任何房间或票据锁。
    // 停机交权的所有者无法写入配对，且一旦排空开始配对就无法提交：中途开始的排空会等待本事务完成，而非产生竞态。
    await assertOwnership(tx);
    await assertAdmission(tx);
    const now = Date.now();

    const mine = await readTicket(tx, user.id);
    if (!mine || mine.state !== 'waiting' || mine.expires_at <= now) return null;
    const [partner] = await tx
      .select()
      .from(matchTickets)
      .where(
        and(
          ne(matchTickets.user_id, user.id),
          eq(matchTickets.state, 'waiting'),
          gt(matchTickets.expires_at, now),
        ),
      )
      .orderBy(asc(matchTickets.created_at), asc(matchTickets.user_id))
      .limit(1);
    if (!partner) return null;

    // 锁定双方记录，账户 ID 较小的排在前面：该全局全序锁顺序可避免两路并发轮询在彼此票据上死锁。
    const ordered = [user.id, partner.user_id].sort();
    let partnerRow: TicketRow | null = null;
    for (const id of ordered) {
      const row = await lockTicket(tx, id);
      if (id === user.id) {
        if (!row || row.state !== 'waiting' || row.expires_at <= now) return null;
      } else {
        if (!row || row.state !== 'waiting' || row.expires_at <= now) return null;
        partnerRow = row;
      }
    }
    if (!partnerRow) return null;

    const roomId = newRoomId();
    const expiresAt = now + RESERVATION_TTL_MS;
    // 房间、双方预留席位及双方票据：在单个事务中全部成功或全部取消。`createRoom` 设置
    // 房间自身的预留时钟；票据镜像其 TTL，以便客户端看到一致的截止时间。
    await createRoom(tx, {
      id: roomId,
      host: { id: user.id, username: user.username },
      theme: THEME_PRESETS[Math.floor(Math.random() * THEME_PRESETS.length)].theme,
      mode: 'quick',
      reserved: [{ id: partnerRow.user_id, username: partnerRow.username }],
    });
    await tx
      .update(matchTickets)
      .set({ state: 'matched', room_id: roomId, expires_at: expiresAt, updated_at: now })
      .where(inArray(matchTickets.user_id, [user.id, partnerRow.user_id]));
    return { state: 'matched', roomId, expiresAt };
  });
}

// -------------------------------------------------------------------- 虚拟对手回退保底

/**
 * 为已至少等待 `QUICK_GHOST_FALLBACK_MS` 的独处等待者分配虚拟对手——
 * 真实对手始终优先匹配，因此该逻辑仅在 `attemptPairing` 未找到人时执行。
 * 若此处发现存活的等待票据——即在配对尝试与本事务间隙新加入的玩家——则优先让其胜出：
 * 该窥视读取不加锁，因此绝不会与配对按 user_id 加锁的顺序产生死锁，下次轮询即可完成真实配对。
 * 若无此对手，优先匹配合格的重播重影；若亦无合格重影，则回退为生成的机器人。
 * 无论何种情况，均在单个事务内创建房间、安排虚拟对手（出生即入座且就绪，`slot_expires_at` 为 null：
 * 永远不会有实际连接或会话到来），并仅消费调用方的票据（转为该房间的已匹配席位）。
 * 虚拟对手方不持有账户行与票据，因此该账户依然严格仅占用一个全局席位。
 * 当票据在并发轮询的配对或取消中已被变动，则不写入任何内容，调用方继续保持等待应答。
 *
 * 栅障与准入判定最先执行，与配对逻辑完全一致：停机交权的所有者不分配任何资源，
 * 且在分配中途开启的排空会等待此事务完成而非产生竞态。
 * 票据在锁保护下重新读取，确保截止时间判定是基于即将被消费的那一行数据，而非基于更早刷新的快照。
 */

async function assignSyntheticPartner(
  database: Database,
  user: User,
  assertOwnership: (tx: Transaction) => Promise<void>,
): Promise<MatchTicket | null> {
  return database.transaction(async (tx): Promise<MatchTicket | null> => {
    await assertOwnership(tx);
    await assertAdmission(tx);
    const now = Date.now();

    const mine = await lockTicket(tx, user.id);
    if (!mine) return null;
    // 在刷新与本事务间隙，并发轮询赢得了席位：直接以该席位应答。
    if (mine.state === 'matched') return matchedTicketOf(mine);
    if (mine.state !== 'waiting' || mine.expires_at <= now) return null;
    if (now - mine.created_at < QUICK_GHOST_FALLBACK_MS) return null;

    // 在配对尝试与当前时刻之间新加入的玩家绝不能被虚拟对手绕过：将其留给本次轮询的下一轮配对流程。特意采用无锁检查。
    const [newcomer] = await tx
      .select({ user_id: matchTickets.user_id })
      .from(matchTickets)
      .where(
        and(
          ne(matchTickets.user_id, user.id),
          eq(matchTickets.state, 'waiting'),
          gt(matchTickets.expires_at, now),
        ),
      )
      .limit(1);
    if (newcomer) return null;

    const ghost = await chooseGhost(tx, user.id);
    const theme = ghost
      ? ghost.theme
      : THEME_PRESETS[Math.floor(Math.random() * THEME_PRESETS.length)].theme;

    const roomId = newRoomId();
    const seatId = syntheticSeatId(roomId);
    const expiresAt = now + RESERVATION_TTL_MS;
    // 房间、虚拟席位、对手标记及调用方被消费的票据：单个事务原子完成。
    // `createRoom` 设置房间自身的预留时钟；票据镜像其 TTL，使得客户端看到统一的截止时间。
    await createRoom(tx, {
      id: roomId,
      host: { id: user.id, username: user.username },
      // 重影会重播其录制时的专属主题：对局开始时恢复的源法术书即为其度身打造，确保房间与法术书绝不冲突。
      // 机器人则使用预设主题并正常走生成流程。
      theme,
      mode: 'quick',
      reserved: [{ id: seatId, username: SYNTHETIC_OPPONENT_NAME }],
    });
    await tx
      .update(players)
      .set({ seated: 1, ready: 1, slot_expires_at: null })
      .where(and(eq(players.room_id, roomId), eq(players.user_id, seatId)));
    // 对手类型决定了运行时采用的对手引擎；仅重影类型会指定源重播 ID。
    await updateRoom(
      tx,
      roomId,
      ghost ? { opponent_kind: 'ghost', ghost_id: ghost.id } : { opponent_kind: 'bot' },
    );
    await tx
      .update(matchTickets)
      .set({ state: 'matched', room_id: roomId, expires_at: expiresAt, updated_at: now })
      .where(eq(matchTickets.user_id, user.id));
    return { state: 'matched', roomId, expiresAt };
  });
}

// ------------------------------------------------------------------ 席位裁定与共享锁

/**
 * 判断房间当前是否仍持有该账户的席位。进行中的活跃阶段将一直持有席位，直到账户显式退出正在运行的比赛
 * （存在指明当前比赛 ID 的 `departures` 记录）；已结算比赛与已失效预留不持有席位。
 */

async function seatHeld(tx: QueryDatabase, room: RoomRow, userId: string): Promise<boolean> {
  if (MATCH_ACTIVE[room.phase]) return !(await seatReleasedByDeparture(tx, room, userId));
  if (room.phase !== 'lobby') return false;
  if (room.mode !== 'quick' || room.reservation_state !== 'reserved') return false;
  return room.reservation_expires_at !== null && room.reservation_expires_at > Date.now();
}

/** 当该账户已显式放弃其在房间当前运行的比赛中的席位时返回 true。 */
async function seatReleasedByDeparture(
  tx: QueryDatabase,
  room: RoomRow,
  userId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ match_id: departures.match_id })
    .from(departures)
    .where(and(eq(departures.room_id, room.id), eq(departures.user_id, userId)))
    .limit(1);
  return row !== undefined && row.match_id === room.match_id;
}

/**
 * 从匹配端清理存活（或刚刚失效）的快速匹配预留：房间记录取消原因、删除双方预留席位，
 * 并释放双方账户的匹配票据，使另一方账户下次轮询能够重新排队而非追逐已失效的房间。
 * 房间行自身依然保留，以便运行时能向查看该房间的任何人展示具体发生的原因。
 */
async function cancelReservedPairing(tx: Transaction, room: RoomRow, now: number): Promise<void> {
  const live = room.reservation_expires_at !== null && room.reservation_expires_at > now;
  await tx
    .update(rooms)
    .set({
      reservation_state: live ? 'cancelled' : 'expired',
      reservation_expires_at: null,
      error: live ? '匹配已取消，请重新匹配。' : '匹配超时，请重新匹配。',
      updated_at: now,
    })
    .where(eq(rooms.id, room.id));
  await tx.delete(players).where(eq(players.room_id, room.id));
  await tx
    .delete(matchTickets)
    .where(and(eq(matchTickets.room_id, room.id), eq(matchTickets.state, 'matched')));
}

async function readTicket(executor: QueryDatabase, userId: string): Promise<TicketRow | null> {
  const [row] = await executor
    .select()
    .from(matchTickets)
    .where(eq(matchTickets.user_id, userId))
    .limit(1);
  return row ?? null;
}

async function lockTicket(executor: QueryDatabase, userId: string): Promise<TicketRow | null> {
  const [row] = await executor
    .select()
    .from(matchTickets)
    .where(eq(matchTickets.user_id, userId))
    .for('update');
  return row ?? null;
}

async function lockRoom(executor: QueryDatabase, roomId: string): Promise<RoomRow | null> {
  const [row] = await executor.select().from(rooms).where(eq(rooms.id, roomId)).for('update');
  return row ?? null;
}
