import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { rooms } from '../db/schema';
import type { Database, Transaction } from '../db';
import { acquireRuntime, type RuntimeOwnership } from '../maintenance/ownership';
import type { InputPolicyMode } from '../../shared/protocol';
import type {
  AuthenticatedSession,
  GenerateSpells,
  RoomRuntimePort,
  RoomSocket,
  RoomSocketData,
} from '../contracts';
import type { RoomSnapshot, ReservationState, User } from '../../shared/protocol';
import { reservationIsGone } from './rules';
import { reservationStateOf } from './reservation';
import { RoomRejection } from './rejection';
import { snapshotFor } from './snapshots';
import { abandonedMatch } from './storage/departures';
import { accountIsBanned } from './storage/accounts';
import { sessionIsLive } from './storage/room-sessions';
import { RoomEngine } from './engine';

export interface RoomRuntimeOptions {
  database: Database;
  generate: GenerateSpells;
  /** 本运行时开启的每场比赛锁定在其房间数据行中的打字时间策略模式。 */
  inputPolicyMode: InputPolicyMode;
}

/** 运行时重新检查其实例化房间是否有外部数据库变更的周期。 */
const WATCH_SWEEP_MS = 5_000;

/**
 * 原生房间运行时：拥有所有房间的唯一进程。
 * 它持有全局运行时租约（维护层的所有权模块），为所触及的每个房间维护
 * 一个带有串行化命令队列的专属引擎，将每个房间最早的持久化截止时间记录在 `next_alarm_at` 中，
 * 并在启动时恢复到期工作。
 */
export class RoomRuntime implements RoomRuntimePort {
  readonly runtimeEpoch: number;

  private readonly engines = new Map<string, RoomEngine>();
  private watch: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  private constructor(
    readonly database: Database,
    readonly generate: GenerateSpells,
    readonly inputPolicyMode: InputPolicyMode,
    private readonly ownership: RuntimeOwnership,
  ) {
    this.runtimeEpoch = ownership.epoch;
  }

  /**
   * 获取全局运行时租约并恢复所有仍有待处理工作的房间。
   * 租约被占用 —— 存在另一个活跃所有者 —— 将导致启动失败：两个所有者会导致房间并发竞态。
   * 未携带锁定输入策略的活跃房间也会导致启动失败：运行时拒绝接管一场
   * 既无法裁决也无法结算的比赛。
   */
  static async start(options: RoomRuntimeOptions): Promise<RoomRuntime> {
    const ownership = await acquireRuntime(options.database, {
      onLost: () => {
        void runtime.handleOwnershipLost();
      },
    });
    const runtime = new RoomRuntime(
      options.database,
      options.generate,
      options.inputPolicyMode,
      ownership,
    );
    try {
      await runtime.rejectUnmeasuredActiveRooms();
      await runtime.recover();
      runtime.watch = setInterval(() => runtime.sweep(), WATCH_SWEEP_MS);
      runtime.watch.unref();
    } catch (error) {
      await ownership.close();
      throw error;
    }
    return runtime;
  }

  // ------------------------------------------------------------------ 端口 API

  /**
   * 在接管房间之前验证其是否存在。协调层和 HTTP 可能会向本运行时传递
   * 陈旧或未知的房间 ID（取消的结果、旧的定位器）；缺失的房间属于拒绝情况，
   * 绝不执行接管。运行时恰好只有一个，因此已存在的房间始终归本运行时所有。
   */
  private async engineForOwnRoom(roomId: string): Promise<RoomEngine> {
    const rows = await this.database
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (rows[0] === undefined) throw new RoomRejection('room:not_found', '房间不存在或已结束。');
    return this.engineFor(roomId);
  }

  async snapshot(roomId: string, user: User): Promise<RoomSnapshot> {
    const engine = await this.engineForOwnRoom(roomId);
    return snapshotFor(this.database, roomId, engine.registry, user);
  }

  /**
   * HTTP 升级前的只读验证：房间存在、其预留未失效、该账户未放弃对局、会话依然有效且账户未被封禁。
   * 权威的会话与封禁检查会在加入事务内再次执行，在该事务中注册与登出/封禁恰好发生一次竞态。
   */
  async authorizeSocket(roomId: string, session: AuthenticatedSession): Promise<void> {
    const rows = await this.database.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    const room = rows[0];
    if (room === undefined) throw new RoomRejection('room:not_found', '房间不存在或已结束。');
    if (reservationIsGone(room, Date.now()))
      throw new RoomRejection('room:reservation_gone', '匹配已结束，请重新匹配。');
    if (await abandonedMatch(this.database, roomId, session.user.id, room.match_id))
      throw new RoomRejection('room:reservation_gone', '你已离开本场对局。');
    if (await accountIsBanned(this.database, session.user.id))
      throw new RoomRejection('room:unauthenticated', '该账号已被封禁。');
    if (!(await sessionIsLive(this.database, session.tokenHash)))
      throw new RoomRejection('room:unauthenticated', '登录状态无效，请重新登录。');
  }

  connect(socket: RoomSocket): void {
    const data: RoomSocketData = socket.data;
    this.engineFor(data.roomId).connect(data, socket);
  }

  message(socket: RoomSocket, message: string | Uint8Array): void {
    this.engineFor(socket.data.roomId).message(socket, message);
  }

  disconnect(socket: RoomSocket): void {
    this.engineFor(socket.data.roomId).disconnect(socket);
  }

  async leaveRoom(roomId: string, userId: string): Promise<void> {
    const engine = await this.engineForOwnRoom(roomId);
    await engine.leaveRoom(userId);
  }

  async revokeSession(tokenHash: string): Promise<void> {
    const targets = [...this.engines.values()].filter((engine) =>
      engine.registry
        .list()
        .some((socket) => engine.registry.metaOf(socket)?.sessionHash === tokenHash),
    );
    const acknowledged = await Promise.all(
      targets.map((engine) => engine.revokeSession(tokenHash)),
    );
    if (acknowledged.some((ok) => !ok)) throw new Error('room:revoke_incomplete');
  }

  /** 终止单个账户的所有在线连接 —— 封禁针对账户，任何会话或标签页都不例外。 */
  async revokeUser(userId: string): Promise<void> {
    const targets = [...this.engines.values()].filter((engine) =>
      engine.registry.list().some((socket) => engine.registry.metaOf(socket)?.userId === userId),
    );
    const acknowledged = await Promise.all(targets.map((engine) => engine.revokeUser(userId)));
    if (acknowledged.some((ok) => !ok)) throw new Error('room:revoke_incomplete');
  }

  /** 接管并协调单个房间：接管仅存在于 DB 中的房间并同步外部变更。 */
  async refreshRoom(roomId: string): Promise<void> {
    const engine = await this.engineForOwnRoom(roomId);
    await engine.refresh();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.watch !== null) {
      clearInterval(this.watch);
      this.watch = null;
    }
    await Promise.all([...this.engines.values()].map((engine) => engine.stop()));
    await this.ownership.close();
  }

  // ------------------------------------------------------------------ 内部实现

  /** 每个房间变更事务在执行首条语句前断言的所有权写入隔离界限。 */
  assertOwnership(tx: Transaction): Promise<void> {
    return this.ownership.assert(tx);
  }

  /** 供协调读取的预留状态；未初始化的房间读取为 `none`。 */
  async reservationState(roomId: string): Promise<ReservationState> {
    const rows = await this.database.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    return reservationStateOf(rows[0] ?? null, Date.now());
  }

  /**
   * 获取或实例化单个房间的引擎。构建过程为同步操作，
   * 因此获取或创建具有原子性；定时器仅在排队的命令内挂载。
   */
  private engineFor(roomId: string): RoomEngine {
    let engine = this.engines.get(roomId);
    if (engine === undefined) {
      engine = new RoomEngine(this, roomId);
      this.engines.set(roomId, engine);
    }
    return engine;
  }

  /**
   * 启动恢复：每个需要唤醒的房间 —— 到期的定时器、活跃的对局、开放的预留、开放的大厅 ——
   * 均会获取其引擎并立即执行追赶处理。因崩溃而中断的题目生成会被追赶流程如实标记失败，
   * 完全符合告警追赶的机制。
   */
  private async recover(): Promise<void> {
    const now = Date.now();
    const due = await this.database
      .select({ id: rooms.id })
      .from(rooms)
      .where(
        or(
          and(isNotNull(rooms.next_alarm_at), sql`${rooms.next_alarm_at} <= ${now}`),
          inArray(rooms.phase, ['generating', 'countdown', 'playing']),
          eq(rooms.reservation_state, 'reserved'),
          and(eq(rooms.locked, 0), eq(rooms.phase, 'lobby')),
        ),
      );
    await Promise.all(due.map((row) => this.engineFor(row.id).catchup()));
  }

  /**
   * 拒绝接管处于生成中、倒计时或进行中但从未锁定比赛策略的房间：
   * 裁决、快照和结算均读取这些字段，在比赛中途衡量会为已经输入的法术捏造开始时间。
   * 该检查是对所有活跃房间执行的一次启动查询 —— 单个运行时拥有它们全部，
   * 因此未计量的活跃比赛必然属于本运行时的管辖范围，且必然导致启动失败。
   */
  private async rejectUnmeasuredActiveRooms(): Promise<void> {
    const unmeasured = await this.database
      .select({ id: rooms.id, phase: rooms.phase })
      .from(rooms)
      .where(
        and(
          inArray(rooms.phase, ['generating', 'countdown', 'playing']),
          or(
            isNull(rooms.input_policy_version),
            isNull(rooms.input_policy_mode),
            isNull(rooms.input_min_ms_per_code_point),
          ),
        ),
      );
    const first = unmeasured[0];
    if (first === undefined) return;
    console.error({ roomId: first.id, phase: first.phase, reason: 'input_policy_drain_required' });
    throw new Error('input_policy_drain_required');
  }

  /** 周期性监控：重新读取已提交状态，以便外部数据库变更能及时体现。 */
  private sweep(): void {
    if (this.stopped) return;
    for (const engine of this.engines.values()) void engine.refresh();
  }

  /** 租约被接管或已过期：停止所有工作并释放所有套接字。 */
  private async handleOwnershipLost(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    console.error('[room] runtime ownership lost; stopping');
    if (this.watch !== null) {
      clearInterval(this.watch);
      this.watch = null;
    }
    await Promise.all([...this.engines.values()].map((engine) => engine.stop()));
  }
}

/**
 * 创建房间运行时：获取全局运行时租约，恢复到期房间，并返回 Main 组装挂载的端口对象。
 * 生成函数是由 Main 组装注入的流水线 —— 测试用例则使用针对测试模型的真实流水线。
 */
export async function createRoomRuntime(options: RoomRuntimeOptions): Promise<RoomRuntimePort> {
  return RoomRuntime.start(options);
}
