import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { MaintenanceError } from '../../shared/maintenance';
import type { Database, Transaction } from '../db';
import { runtimeControl } from '../db/schema';

/**
 * 全局唯一定位游戏运行时的运行时所有权管理。
 *
 * 严格保证只能有一个进程驱动房间流转，且“究竟是哪个进程”必须在进程重启、崩溃后拉起重复进程
 * 以及刚好共享同一个 Compose 容器名的场景下均能正确区分。`runtime_control` 行即为所有权记录：
 * `runtime_id` 是当前所有者的令牌，`runtime_epoch` 是单调递增的全局世代号，
 * `lease_until` 与数据库自身时钟进行比对，限定了该记录保持可信的时间窗口。
 *
 * - `acquireRuntime` 在 `FOR UPDATE` 下锁定该行：全新申领或对过期租约的接管均会递增世代号；
 *   若在有效租约仍被持有时出现重复实例，则会被拒绝直至租约真正过期（崩溃的所有者由运维拉起，
 *   绝不进行竞态抢占）。过期的租约绝不可直接复活——重新恢复必须获取新的世代号。
 * - `assert(tx)` 是写入栅障。每个房间变更事务均以其开启：锁定控制行，依据最新的数据库时钟读取租约，
 *   若非当前令牌在未过期的租约上持有完全一致的世代号则直接抛出异常——因此迟到的心跳、僵尸异步回调
 *   或故障后租约已失效的原所有者均绝无可能成功写入。
 * - 心跳机制仅做*续约*：当租约已失效或已被接管时拒绝续期，并在这些情况下触发 `onLost`，
 *   绝不尝试复活已丢失的所有权。退出的所有者只能通过再次调用 `acquireRuntime` 重新加入并获取新的世代号。
 * - `close()` 仅在租约仍归属自身时将其释放。
 *
 * 时序规则：`now()` 在事务开启时冻结，跨锁等待后便会失效变陈旧，因此此处所有时钟读取
 * 均在行锁*之后*执行 `clock_timestamp()`。加锁顺序：本模块仅触碰控制行；
 * 调用方首先获取控制行（通过 `assert`），其后方可锁定房间行和票据行。
 */

/** 在没有心跳续期的情况下租约的有效时长，以数据库系统时钟计量。 */
const LEASE_MS = 30_000;

/** 租约已被接管或已过期：当前实例必须立即停机交权。 */
export class RuntimeOwnershipLostError extends Error {
  constructor(epoch: number) {
    super(`运行时所有权（第 ${epoch} 代）已经丢失，本次写入被拒绝。`);
    this.name = 'RuntimeOwnershipLostError';
  }
}

/** 另一个存活的所有者正在持有租约：这是重复启动的进程，而非所有权丢失。 */
export class RuntimeOwnershipBusyError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'RuntimeOwnershipBusyError';
    this.retryable = retryable;
  }
}

/** 房间运行时在每个变更事务内部调用的写入栅障。 */
export interface RuntimeOwnership {
  readonly epoch: number;
  /** 除非当前令牌依然持有有效租约，否则抛出 `RuntimeOwnershipLostError`。会对控制行加锁。 */
  assert(tx: Transaction): Promise<void>;
  /** 当租约仍属于当前实例时予以释放；具有幂等性，绝不触碰后继者的租约。 */
  close(): Promise<void>;
}

export interface AcquireRuntimeOptions {
  /** 心跳发现租约丢失时触发一次。必须立即让运行时下线停机。 */
  onLost?: () => void;
  leaseMs?: number;
  heartbeatMs?: number;
}

interface OwnedRow {
  runtime_id: string | null;
  runtime_epoch: number;
  lease_until: number | null;
}

/** 排他锁定控制行，随后使用最新的数据库时钟读取其所有权记录。 */
async function lockedOwnedRow(tx: Transaction): Promise<{ row: OwnedRow; nowMs: number } | null> {
  const [row] = await tx
    .select({
      runtime_id: runtimeControl.runtime_id,
      runtime_epoch: runtimeControl.runtime_epoch,
      lease_until: runtimeControl.lease_until,
    })
    .from(runtimeControl)
    .limit(1)
    .for('update');
  if (!row) return null;
  const [clock] = await tx
    .select({ now: sql<number>`(extract(epoch from clock_timestamp()) * 1000)`.mapWith(Number) })
    .from(runtimeControl)
    .limit(1);
  if (!clock) return null;
  return { row, nowMs: Math.floor(clock.now) };
}

function leaseIsLive(row: OwnedRow, nowMs: number): boolean {
  return row.runtime_id !== null && row.lease_until !== null && row.lease_until > nowMs;
}

/**
 * 在共享锁保护下的租约记录，随后读取最新的数据库时钟。`assert` 使用此方法而非排他锁：
 * 多个房间事务可以同时持有控制行的 `FOR SHARE` 共享锁——随后各自在自己的房间行上串行化——
 * 同时共享锁仍能阻断所有接管和心跳续约操作，直至房间事务提交。
 * 这是房间事务获取的第一个锁，因此排他持有者绝不会阻塞等待本事务已经持有的房间行。
 */
async function sharedOwnedRow(tx: Transaction): Promise<{ row: OwnedRow; nowMs: number } | null> {
  const [row] = await tx
    .select({
      runtime_id: runtimeControl.runtime_id,
      runtime_epoch: runtimeControl.runtime_epoch,
      lease_until: runtimeControl.lease_until,
    })
    .from(runtimeControl)
    .limit(1)
    .for('share');
  if (!row) return null;
  const [clock] = await tx
    .select({ now: sql<number>`(extract(epoch from clock_timestamp()) * 1000)`.mapWith(Number) })
    .from(runtimeControl)
    .limit(1);
  if (!clock) return null;
  return { row, nowMs: Math.floor(clock.now) };
}

export async function acquireRuntime(
  database: Database,
  options: AcquireRuntimeOptions = {},
): Promise<RuntimeOwnership> {
  const leaseMs = options.leaseMs ?? LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? Math.max(1_000, Math.floor(leaseMs / 3));
  const token = randomUUID().replace(/-/g, '');
  let closed = false;
  let lost = false;

  const fireLost = () => {
    if (lost) return;
    lost = true;
    try {
      options.onLost?.();
    } catch {
      // 回调抛出异常不得中断心跳循环；所有权此时已然丢失。
    }
  };

  const epoch = await database.transaction(async (tx) => {
    const locked = await lockedOwnedRow(tx);
    if (!locked) throw new MaintenanceError('maintenance:unavailable');
    const { row, nowMs } = locked;
    if (leaseIsLive(row, nowMs)) {
      throw new RuntimeOwnershipBusyError('运行时租约仍有效，重复的运行实例必须等待其到期。', true);
    }
    const nextEpoch = row.runtime_epoch + 1;
    await tx
      .update(runtimeControl)
      .set({
        runtime_id: token,
        runtime_epoch: nextEpoch,
        lease_until: nowMs + leaseMs,
        updated_at: nowMs,
      })
      .where(eq(runtimeControl.singleton, 1));
    return nextEpoch;
  });

  const heartbeat = async (): Promise<void> => {
    if (closed || lost) return;
    try {
      const renewed = await database.transaction(async (tx) => {
        const locked = await lockedOwnedRow(tx);
        if (!locked) return false;
        const { row, nowMs } = locked;
        // 仅允许续约：租约已失效或被接管意味着所有权已经丧失；绝不可在此复活该记录。
        if (row.runtime_id !== token || row.runtime_epoch !== epoch || !leaseIsLive(row, nowMs)) {
          return false;
        }
        await tx
          .update(runtimeControl)
          .set({ lease_until: nowMs + leaseMs, updated_at: nowMs })
          .where(
            and(
              eq(runtimeControl.singleton, 1),
              eq(runtimeControl.runtime_id, token),
              eq(runtimeControl.runtime_epoch, epoch),
            ),
          );
        return true;
      });
      if (!renewed) fireLost();
    } catch {
      // 数据库瞬态故障：无论如何变更操作都会通过 `assert` 故障阻断，若故障时间超过租约则租约自然失效。下次心跳将继续重试。
    }
  };

  const timer = setInterval(() => void heartbeat(), heartbeatMs);
  timer.unref?.();

  return {
    epoch,
    async assert(tx: Transaction): Promise<void> {
      if (closed || lost) throw new RuntimeOwnershipLostError(epoch);
      const locked = await sharedOwnedRow(tx);
      if (!locked) {
        fireLost();
        throw new RuntimeOwnershipLostError(epoch);
      }
      const { row, nowMs } = locked;
      const ours = row.runtime_id === token && row.runtime_epoch === epoch;
      if (!ours || !leaseIsLive(row, nowMs)) {
        fireLost();
        throw new RuntimeOwnershipLostError(epoch);
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try {
        await database.transaction(async (tx) => {
          const [row] = await tx
            .select({
              runtime_id: runtimeControl.runtime_id,
              runtime_epoch: runtimeControl.runtime_epoch,
            })
            .from(runtimeControl)
            .limit(1)
            .for('update');
          if (!row || row.runtime_id !== token || row.runtime_epoch !== epoch) return;
          await tx
            .update(runtimeControl)
            .set({ runtime_id: null, lease_until: null, updated_at: Date.now() })
            .where(eq(runtimeControl.singleton, 1));
        });
      } catch {
        // 停机时数据库无法连接；租约将自行自然过期，重启的实例将在其过期后接管。此处无法做出诚实的声明。
      }
    },
  };
}
