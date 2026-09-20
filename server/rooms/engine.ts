import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { rooms } from '../db/schema';
import { WS_CLOSE, WS_CLOSE_RESTART } from '../../shared/protocol';
import type { RoomSocket, RoomSocketData } from '../contracts';
import type { AuthenticatedSession } from '../contracts';
import { clientMessageSchema } from '../../shared/validation';
import { MAX_MESSAGE_BYTES } from '../../shared/protocol';
import { RoomRejection } from './rejection';
import { SEAT_TTL_MS, MESSAGE_LENGTH_FAST_PATH, MAX_CATCHUP_STEPS } from './rules';
import { reservationIsGone } from './rules';
import { createRoomScope, InputBudget, SocketRegistry } from './scope';
import type { RoomScope, SocketAuth } from './scope';
import { pushSnapshots } from './snapshots';
import {
  closeAllSockets,
  closeSocket,
  currentProtocolSocket,
  dropSessionRef,
  reconcileHost,
  rejectStaleSocket,
  sendTo,
  unbindSeat,
} from './sockets';
import { abandonedMatch } from './storage/departures';
import { accountIsBanned } from './storage/accounts';
import { getPlayer, insertPlayer, updatePlayer } from './storage/players';
import { getRoom, updateRoom } from './storage/room';
import { registerSessionRoom } from './storage/room-sessions';
import { armRoom } from './timers';
import { advanceOnce } from './transitions';
import { applyGenerationOutcome } from './spellbook';
import { handleClientFrame } from './frames';
import { manualLeave } from './leave';
import { maybeAutoStartTx } from './match';
import { reservationStateOf, endReservation } from './reservation';
import type { RoomRuntime } from './runtime';

/** 单次加入被拒绝的情况，在 HTTP 升级已经成功后通过通道内通知。 */
type JoinRefusal = { closeCode: number; message: string };

/**
 * 单个房间的活跃引擎：管理其套接字、串行化命令队列及其定时器。
 * 任何状态变更 —— 数据帧、加入、追赶处理、凭证撤销 ——
 * 均进入该队列，因此同一个房间的两个命令绝不会交错执行，
 * 且每个命令的状态变更都在隔离保护的事务中提交。
 */
export class RoomEngine {
  readonly registry = new SocketRegistry();
  readonly input = new InputBudget();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private progressTimer: NodeJS.Timeout | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  readonly scope: RoomScope;

  constructor(
    private readonly runtime: RoomRuntime,
    readonly roomId: string,
  ) {
    this.scope = createRoomScope({
      roomId,
      db: runtime.database,
      generate: runtime.generate,
      registry: this.registry,
      input: this.input,
      inputPolicyMode: runtime.inputPolicyMode,
      transact: (fn) =>
        this.runtime.database.transaction(async (tx) => {
          // 所有权界限是每个变更事务的第一条语句，
          // 确保过期的所有者在租约丢失后无法写入：
          // 在读取任何房间数据行之前先锁定 runtime_control（准入与所有权）。
          // 房间本身也被锁定，因此每个命令的状态变更在持有的界限下按房间串行化。
          await this.runtime.assertOwnership(tx);
          const owned = await tx
            .select({ id: rooms.id })
            .from(rooms)
            .where(eq(rooms.id, roomId))
            .for('update')
            .limit(1);
          if (owned[0] === undefined)
            throw new RoomRejection('room:not_found', '房间不存在或已结束。');
          return fn(tx);
        }),
      push: async (scope) => {
        clearTimeout(this.progressTimer);
        this.progressTimer = undefined;
        await pushSnapshots(scope);
      },
      pushProgress: () => this.scheduleProgress(),
      arm: (scope) =>
        armRoom(scope, (when) => {
          this.setTimer(when);
        }),
    });
  }

  /** 串行化每个房间命令；FIFO 顺序确保 open → frames → close 的顺序。 */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ------------------------------------------------------------- Socket 事件

  /** 接纳一个升级后的套接字：元数据和事件绑定在任何帧到达之前就绪。 */
  connect(data: RoomSocketData, socket: RoomSocket): void {
    if (this.stopped) {
      closeSocket(socket, WS_CLOSE_RESTART, 'server restarting');
      return;
    }
    const auth: SocketAuth = {
      userId: data.session.user.id,
      username: data.session.user.username,
      connId: randomUUID(),
      sessionHash: data.session.tokenHash,
      sessionExpires: data.session.expiresAt,
      protocolVersion: data.protocolVersion,
    };
    this.registry.attach(socket, auth);
    void this.enqueue(async () => {
      if (this.stopped) {
        closeSocket(socket, WS_CLOSE_RESTART, 'server restarting');
        return;
      }
      try {
        // 无法指明本构建版本网络传输协议的连接绝不被允许加入：
        // 通知一次后立即切断，房间随之对其离去进行协调对齐。
        if (!currentProtocolSocket(auth)) {
          await rejectStaleSocket(this.scope, socket, auth);
          await this.afterSocketCut();
          return;
        }
        await this.join(data.session, socket, auth);
      } catch (error) {
        console.error(
          '[room] join failed',
          this.roomId,
          error instanceof Error ? error.message : typeof error,
        );
        sendTo(socket, { type: 'error', message: '服务器内部错误' });
        closeSocket(socket, WS_CLOSE.closed, 'join failed');
      }
    });
  }

  /** 将单个数据帧路由至房间队列；在加入仍在挂起等待时不会丢失任何帧。 */
  message(socket: RoomSocket, raw: string | Uint8Array): void {
    void this.enqueue(async () => {
      const meta = this.registry.metaOf(socket);
      if (!meta) {
        closeSocket(socket, 1008, 'unknown connection');
        return;
      }
      // 未使用本构建版本协议的连接可能会发送排队的数据帧：
      // 绝不从该房间不支持的协议中解析任何内容。
      // 先剥离其权限，然后执行常规的三部曲 —— 关闭回调将发现席位已被解绑并跳过它们。
      if (!currentProtocolSocket(meta)) {
        await rejectStaleSocket(this.scope, socket, meta);
        await this.afterSocketCut();
        return;
      }
      if (typeof raw !== 'string') {
        sendTo(socket, { type: 'error', message: '不支持的消息格式。' });
        return;
      }
      if (
        raw.length > MAX_MESSAGE_BYTES ||
        (raw.length > MESSAGE_LENGTH_FAST_PATH &&
          new TextEncoder().encode(raw).length > MAX_MESSAGE_BYTES)
      ) {
        sendTo(socket, { type: 'error', message: '消息过大。' });
        return;
      }
      if (meta.sessionExpires <= Date.now()) {
        sendTo(socket, { type: 'error', message: '登录状态已过期，请重新登录。' });
        closeSocket(socket, WS_CLOSE.sessionExpired, 'session expired');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendTo(socket, { type: 'error', message: '消息格式错误。' });
        return;
      }
      // 缺少强制性草稿世代（epoch）的输入除了其自声明的版本外均属于旧版客户端：
      // 直接将其切断，而不是对每个数据包都回复通用的 schema 错误。
      // 任何其他无效数据在下方仍作为常规 schema 拒绝处理。
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'type' in parsed &&
        parsed.type === 'input' &&
        !('draftEpoch' in parsed)
      ) {
        await rejectStaleSocket(this.scope, socket, meta);
        await this.afterSocketCut();
        return;
      }
      const clientMessage = clientMessageSchema.safeParse(parsed);
      if (!clientMessage.success) {
        sendTo(socket, { type: 'error', message: '消息格式错误。' });
        return;
      }
      try {
        await handleClientFrame(this.scope, socket, meta, clientMessage.data);
      } catch (error) {
        console.error(
          '[room] message handling failed',
          clientMessage.data.type,
          error instanceof Error ? error.message : typeof error,
        );
        sendTo(socket, { type: 'error', message: '服务器处理失败，请重试。' });
      }
    });
  }

  /** 清理已关闭的套接字；队列将其与并发加入操作串行化。 */
  disconnect(socket: RoomSocket): void {
    const meta = this.registry.detach(socket);
    if (!meta) return;
    this.input.release(meta.connId);
    void this.enqueue(async () => {
      if (this.stopped) return;
      const now = Date.now();
      const released = await this.scope.transact(async (tx) => {
        const unbound = await unbindSeat(tx, this.roomId, meta, now);
        // 删除该房间对会话的引用在接纳连接的同一个事务内完成检查和写入，
        // 因此重新注册该会话的连接绝不会在此删除操作前插入导致其引用被抹除。
        await dropSessionRef(tx, this.roomId, this.registry, meta.sessionHash, socket);
        return unbound;
      });
      if (!released) return;
      await this.scope.transact(async (tx) => reconcileHost(tx, this.roomId, this.registry));
      await pushSnapshots(this.scope);
      await this.arm();
    });
  }

  // --------------------------------------------------------------- 加入流程

  /**
   * 权威性加入流程。会话引用、席位和新连接在同一个受保护的事务内生效为权威状态，
   * 因此登出、席位变更或并发开始绝不会观察到半就绪状态。
   * 被拒绝的加入在通道内下发 —— 错误帧及关闭 —— 因为 HTTP 升级此前已成功。
   */
  private async join(
    session: AuthenticatedSession,
    socket: RoomSocket,
    auth: SocketAuth,
  ): Promise<void> {
    const refusal = await this.scope.transact(async (tx): Promise<JoinRefusal | null> => {
      // 注册与登出的竞态仅发生一次：
      // 单个条件语句仅接受活跃有效的会话行。
      if (!(await registerSessionRoom(tx, session.tokenHash, this.roomId))) {
        return { closeCode: WS_CLOSE.sessionExpired, message: '登录状态已失效，请重新登录。' };
      }
      // 握手后重新检查封禁；此后的封禁会通过运行时队列关闭该已注册连接。
      // 封禁针对账户而非会话 —— 旧会话、新会话、预留席位一律拒绝。
      if (await accountIsBanned(tx, auth.userId)) {
        return { closeCode: WS_CLOSE.sessionExpired, message: '该账号已被封禁。' };
      }
      const room = await getRoom(tx, this.roomId);
      if (!room) {
        return { closeCode: WS_CLOSE.closed, message: '房间不存在或已结束。' };
      }
      if (reservationIsGone(room, Date.now())) {
        return { closeCode: WS_CLOSE.closed, message: '匹配已结束，请重新匹配。' };
      }
      if (await abandonedMatch(tx, this.roomId, auth.userId, room.match_id)) {
        // 明确主动放弃的比赛绝不再重新接纳离开该对局的账户 ——
        // 无论是在延迟的生成后续处理之后，还是在旧标签页上。
        return { closeCode: WS_CLOSE.closed, message: '你已离开本场对局。' };
      }

      if (!(await getPlayer(tx, this.roomId, auth.userId))) {
        if (room.mode === 'quick') {
          return { closeCode: WS_CLOSE.closed, message: '匹配已结束，请重新匹配。' };
        }
        if (room.locked !== 0 || room.phase !== 'lobby') {
          return { closeCode: WS_CLOSE.closed, message: '比赛已开始，无法加入。' };
        }
        const seated = await insertPlayer(tx, this.roomId, {
          userId: auth.userId,
          username: auth.username,
          slotExpiresAt: Date.now() + SEAT_TTL_MS,
          now: Date.now(),
        });
        if (!seated) {
          return { closeCode: WS_CLOSE.closed, message: '房间已满。' };
        }
      }

      // 较新的连接取代同一账户的旧套接字；
      // 稍后会通过 conn_id 忽略它们的关闭事件，因此旧连接不会将新连接标记为已断开。
      for (const other of this.registry.list()) {
        if (other === socket) continue;
        const otherMeta = this.registry.metaOf(other);
        if (otherMeta && otherMeta.userId === auth.userId)
          closeSocket(other, WS_CLOSE.replaced, 'replaced by a newer connection');
      }
      // 席位的活跃连接在注册并接受它的同一个事务中完成绑定，
      // 因此撤销扫描绝不会观察到席位尚未指向的打开套接字。
      await updatePlayer(tx, this.roomId, auth.userId, {
        conn_id: auth.connId,
        slot_expires_at: null,
        seated: 1,
      });
      await reconcileHost(tx, this.roomId, this.registry);
      await maybeAutoStartTx(tx, this.roomId, this.registry, room, this.scope.inputPolicyMode);
      return null;
    });

    if (refusal !== null) {
      sendTo(socket, { type: 'error', message: refusal.message });
      closeSocket(socket, refusal.closeCode, 'join refused');
      return;
    }
    await pushSnapshots(this.scope);
    await this.arm();
  }

  // ---------------------------------------------------------------- 外部状态

  /**
   * 重新读取房间的已提交状态，并协调引擎自身无法直接感知的内容：
   * 匹配调度在数据库中取消的预留、TTL 过期的配对、已消失的房间数据行。
   */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      const room = await getRoom(this.scope.db, this.roomId);
      if (!room) {
        closeAllSockets(this.registry, WS_CLOSE.closed, 'room gone');
        this.setTimer(null);
        return;
      }
      if (
        room.mode === 'quick' &&
        (room.reservation_state === 'cancelled' || room.reservation_state === 'expired')
      ) {
        // 协调调度层在数据库中取消或标记了该配对过期。
        // 镜像房间自身原本会执行的预留结束逻辑：
        // 若席位仍存，房间通知其原因并关闭连接；
        // 若席位已消失，则仅关闭陈旧连接。
        const state = room.reservation_state;
        const ended = await endReservation(this.scope, state, RESERVATION_MESSAGES[state]);
        if (!ended) closeAllSockets(this.registry, WS_CLOSE.closed, state);
        await this.arm();
        return;
      }
      if (
        room.mode === 'quick' &&
        room.reservation_state === 'reserved' &&
        reservationStateOf(room, Date.now()) === 'expired'
      ) {
        await endReservation(this.scope, 'expired', RESERVATION_MESSAGES.expired);
        await this.arm();
        return;
      }
      await pushSnapshots(this.scope);
      await this.arm();
    });
  }

  /** 运行到期流转追赶循环；定时器根据持久化状态重新挂载。 */
  catchup(): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) return;
      try {
        for (let step = 0; step < MAX_CATCHUP_STEPS; step++) {
          const outcome = await advanceOnce(this.scope);
          if (outcome.generation !== undefined) {
            // 尝试在队列外继续执行；其在结算时会自行清除挂起标记并重新挂载定时器。
            void this.runGeneration(outcome.generation);
            break;
          }
          if (!outcome.progressed) break;
        }
      } finally {
        await this.arm();
      }
    }).catch((error) => {
      // 失败的流转（数据库故障）以有界的退避间隔重试，而不是频繁冲击；
      // 追赶失败绝不会丢失保存在房间行中的截止时间。
      console.error(
        '[room] catch-up failed',
        this.roomId,
        error instanceof Error ? error.message : typeof error,
      );
      return this.retryAfterFailure();
    });
  }

  /**
   * 为单个账户执行离开房间操作；向调用方重新抛出房间自身的拒绝异常，
   * 以便 HTTP 层能够进行映射转换。
   */
  leaveRoom(userId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopped) throw new RoomRejection('room:not_found', '房间不存在或已结束。');
      await manualLeave(this.scope, userId);
      await this.arm();
    });
  }

  /**
   * 停止由此会话令牌验证的所有套接字。权限优先，且同步剥离：
   * 每个匹配的连接 —— 包括正在关闭但排队帧仍由席位 conn_id 授权的连接 ——
   * 在任何关闭之前都会失去该权限。
   * 调用方仅在每个房间均确认后才响应登出，因此仍处于打开状态的套接字
   * 必须使此调用失败，而不是静默放行。
   */
  revokeSession(tokenHash: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.stopped) return true;
      const doomed: { socket: RoomSocket; meta: SocketAuth }[] = [];
      for (const socket of this.registry.list()) {
        const meta = this.registry.metaOf(socket);
        if (meta && meta.sessionHash === tokenHash) doomed.push({ socket, meta });
      }
      if (doomed.length === 0) return true;
      for (const { meta } of doomed) this.input.release(meta.connId);
      await this.scope.transact(async (tx) => {
        const now = Date.now();
        for (const { meta } of doomed) await unbindSeat(tx, this.roomId, meta, now);
        await reconcileHost(tx, this.roomId, this.registry);
      });
      let closeFailure: unknown = null;
      for (const { socket } of doomed) {
        if (socket.readyState !== 1) continue;
        try {
          socket.close(WS_CLOSE.sessionExpired, 'session revoked');
        } catch (error) {
          closeFailure ??= error;
        }
      }
      await pushSnapshots(this.scope);
      if (closeFailure !== null || doomed.some(({ socket }) => socket.readyState === 1)) {
        console.error(
          '[room] revocation incomplete',
          this.roomId,
          closeFailure instanceof Error ? closeFailure.name : typeof closeFailure,
        );
        return false;
      }
      await this.arm();
      return true;
    });
  }

  /**
   * 停止代表单个账户的所有套接字 —— 封禁的账户级终局，
   * 与 `revokeSession` 相同的三部曲：同步剥离输入配额、事务内解绑席位、随后物理关闭。
   * 席位的 `conn_id` 一旦被清除，关闭前排队的任何数据帧都无法再对该账户生效。
   */
  revokeUser(userId: string): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.stopped) return true;
      const doomed: { socket: RoomSocket; meta: SocketAuth }[] = [];
      for (const socket of this.registry.list()) {
        const meta = this.registry.metaOf(socket);
        if (meta && meta.userId === userId) doomed.push({ socket, meta });
      }
      if (doomed.length === 0) return true;
      for (const { meta } of doomed) this.input.release(meta.connId);
      await this.scope.transact(async (tx) => {
        const now = Date.now();
        for (const { meta } of doomed) await unbindSeat(tx, this.roomId, meta, now);
        await reconcileHost(tx, this.roomId, this.registry);
      });
      let closeFailure: unknown = null;
      for (const { socket } of doomed) {
        if (socket.readyState !== 1) continue;
        try {
          socket.close(WS_CLOSE.sessionExpired, 'account banned');
        } catch (error) {
          closeFailure ??= error;
        }
      }
      await pushSnapshots(this.scope);
      if (closeFailure !== null || doomed.some(({ socket }) => socket.readyState === 1)) {
        console.error(
          '[room] user revocation incomplete',
          this.roomId,
          closeFailure instanceof Error ? closeFailure.name : typeof closeFailure,
        );
        return false;
      }
      await this.arm();
      return true;
    });
  }

  // -------------------------------------------------------------------- 定时器

  /** 固定窗口合并进度；继续打字不会推迟窗口末尾，停笔也会发出最后一次进度。 */
  private scheduleProgress(): void {
    if (this.stopped) return;
    if (this.progressTimer !== undefined) return;
    const timer = setTimeout(() => {
      void this.enqueue(async () => {
        if (this.progressTimer !== timer || this.stopped) return;
        await this.scope.push();
      }).catch((error) => {
        console.error('[room] progress broadcast failed', this.roomId, error);
      });
    }, 100);
    this.progressTimer = timer;
  }

  private setTimer(when: number | null): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (when === null || this.stopped) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.catchup();
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.max(0, when - Date.now())),
    );
  }

  private async arm(): Promise<void> {
    await armRoom(this.scope, (when) => this.setTimer(when));
  }

  /**
   * 针对权限被提前剥离的套接字（协议过旧、输入超载）执行的协调/快照/告警三部曲：
   * 关闭回调会发现席位已被解绑并跳过它们，因此改在此处运行 ——
   * 每次切断运行一次，而非按套接字运行。
   */
  private async afterSocketCut(): Promise<void> {
    await this.scope.transact((tx) => reconcileHost(tx, this.roomId, this.registry));
    await pushSnapshots(this.scope);
    await this.arm();
  }

  private async retryAfterFailure(): Promise<void> {
    if (this.stopped) return;
    const retryAt = Date.now() + CATCHUP_RETRY_MS;
    try {
      await this.scope.transact(async (tx) => {
        await updateRoom(tx, this.roomId, { next_alarm_at: retryAt });
      });
    } catch {
      // 重试行仅作为提示；下方的内存定时器仍会正常触发。
    }
    this.setTimer(retryAt);
  }

  // ------------------------------------------------------------------ 生成阶段

  /**
   * 在命令队列之外运行已认领的生成尝试：
   * 耗时较长的大模型调用不会阻塞任何操作，
   * 且结果以串行化命令形式重新进入队列，在修改状态前重新验证对局 token。
   */
  private async runGeneration(token: string): Promise<void> {
    // 在首次 await 之前设置：启动本次尝试的追赶流程会紧接着重新挂载定时器，
    // 该标志必须预先将尝试标记为本地所有，否则重新挂载会被视作崩溃遗留的 claim。
    this.scope.inFlightGeneration = token;
    try {
      const room = await getRoom(this.scope.db, this.roomId);
      if (!room || room.phase !== 'generating' || room.generation_token !== token) {
        this.scope.inFlightGeneration = null;
        return;
      }
      const outcome = await this.runtime.generate({
        theme: room.theme,
        variation: `${room.match_id ?? ''}:${room.generation_seq}`,
      });
      await this.enqueue(async () => {
        this.scope.inFlightGeneration = null;
        if (this.stopped) return;
        try {
          await applyGenerationOutcome(this.scope, token, outcome);
          await this.arm();
        } catch (error) {
          console.error(
            '[room] generation apply failed',
            this.roomId,
            error instanceof Error ? error.message : typeof error,
          );
          await this.retryAfterFailure();
        }
      });
    } catch (error) {
      this.scope.inFlightGeneration = null;
      console.error(
        '[room] generation attempt failed',
        this.roomId,
        error instanceof Error ? error.message : typeof error,
      );
      await this.enqueue(async () => {
        if (this.stopped) return;
        await this.retryAfterFailure();
      });
    }
  }

  // --------------------------------------------------------------------- 关闭

  /** 停止定时器并使用可恢复重启错误码关闭所有套接字。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.setTimer(null);
    clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    for (const socket of this.registry.list())
      closeSocket(socket, WS_CLOSE_RESTART, 'server restarting');
    await this.tail;
  }
}

const CATCHUP_RETRY_MS = 2_000;
// 超过此上限的截止时间将在此上限处唤醒，并针对其原始时间戳重新挂载定时器。
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** 取消或超时的配对向其席位传达的原因提示。 */
const RESERVATION_MESSAGES: Record<'cancelled' | 'expired', string> = {
  cancelled: '匹配已取消，请重新匹配。',
  expired: '匹配超时，请重新匹配。',
};
