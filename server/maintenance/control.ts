import { eq, inArray, sql } from 'drizzle-orm';
import { MaintenanceError, type DrainStatus, type MaintenanceInfo } from '../../shared/maintenance';
import type { Database, QueryDatabase, Transaction } from '../db';
import { matchTickets, rooms, runtimeControl, type RuntimeControlRow } from '../db/schema';

/**
 * 持久化维护状态：准入控制、排空（drain）进度观察以及基于版本 CAS 的状态流转。
 *
 * 唯一的 `runtime_control` 行统辖一切。`mode` 决定准入放行与否；`revision` 作为 CAS 令牌，
 * 使得每一次状态转换（`enterMaintenance`/`leaveMaintenance`）在面对并发运维操作时都能确保安全——
 * 过期或重复的操作会被以 `MaintenanceConflict` (409) 明确拒绝，绝不被静默覆盖接管。
 * 排空就绪状态是通过严密计算得出而非主观断言：所有屏障统计计数均在控制行锁保护下读取，
 * 从而确保巡检时绝不会漏掉任何正在处于准入过程中的操作。
 *
 * 全局加锁顺序：runtime_control → rooms → tickets。这些事务内部绝不等待网络 IO，
 * 且每一次截止时间比较均在获取行锁*之后*读取数据库自身的 `clock_timestamp()`——
 * 因为 `now()` 在事务开启时就被冻结，跨锁等待后便会失效变陈旧。
 */

/** 维护状态流转在并发竞态中落败，或引用了陈旧的版本号；请重新读取后重试。 */
export class MaintenanceConflict extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceConflict';
  }
}

/**
 * 以毫秒为单位的数据库权威物理时间，在调用方持有行锁后读取。
 * 当控制行不存在时故障阻断报错：失去控制行就无法为系统状态提供可信担保。
 */
async function databaseNow(executor: QueryDatabase): Promise<number> {
  const [row] = await executor
    .select({ now: sql<number>`(extract(epoch from clock_timestamp()) * 1000)`.mapWith(Number) })
    .from(runtimeControl)
    .limit(1);
  if (!row) throw new MaintenanceError('maintenance:unavailable');
  return Math.floor(row.now);
}

/** 以 `FOR SHARE`（不可与状态转换发生竞态的读取方）或 `FOR UPDATE` 模式锁定控制行。 */
async function lockControl(tx: Transaction, mode: 'share' | 'update'): Promise<RuntimeControlRow> {
  const query = tx.select().from(runtimeControl).limit(1);
  const [row] = await (mode === 'share' ? query.for('share') : query.for('update'));
  if (!row) throw new MaintenanceError('maintenance:unavailable');
  return row;
}

/**
 * 当前已提交的维护状态指针——无行锁，单次 MVCC 快照读。
 * 可在开启的事务中安全调用（用于事务内再次校验准入），亦可直接传入纯数据库实例。
 */
export async function readMaintenance(executor: QueryDatabase): Promise<MaintenanceInfo> {
  const [row] = await executor
    .select({
      mode: runtimeControl.mode,
      revision: runtimeControl.revision,
      updatedAt: runtimeControl.updated_at,
    })
    .from(runtimeControl)
    .limit(1);
  if (!row) throw new MaintenanceError('maintenance:unavailable');
  return row;
}

/**
 * 在控制行锁保护下统计仍阻碍恢复开放的一切未结项。通过行锁保证统计结果绝对可信：
 * 准入操作（`FOR SHARE`）会等待此锁，因此在统计计数与最终裁定之间绝不可能有对局乘隙开启。
 */
export async function inspectMaintenance(database: Database): Promise<DrainStatus> {
  return database.transaction(async (tx) => {
    const control = await lockControl(tx, 'update');
    const now = await databaseNow(tx);
    const [activeMatches] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(rooms)
      .where(inArray(rooms.phase, ['generating', 'countdown', 'playing']));
    const [liveReservations] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(rooms)
      .where(
        sql`${rooms.reservation_state} = 'reserved' and ${rooms.reservation_expires_at} is not null and ${rooms.reservation_expires_at} > ${now}`,
      );
    const [waitingTickets] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(matchTickets)
      .where(eq(matchTickets.state, 'waiting'));
    const [pendingResults] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(rooms)
      .where(sql`${rooms.persistence} in ('saving', 'error')`);
    // 空闲连接和处于大厅的房间故意不作为阻碍项——排空是为了阻止新工作的产生。
    // 属主为空属于已知确定状态（无需提供运行时担保）；租约失效但未优雅释放属于未知异常状态，
    // 在其重新续约或显式释放前阻断排空就绪。
    const runtimeKnown =
      control.runtime_id === null || (control.lease_until !== null && control.lease_until > now);
    return {
      mode: control.mode,
      revision: control.revision,
      updatedAt: control.updated_at,
      activeMatches: activeMatches.total,
      liveReservations: liveReservations.total,
      waitingTickets: waitingTickets.total,
      pendingResults: pendingResults.total,
      runtimeKnown,
      runtimeEpoch: control.runtime_epoch,
      ready:
        control.mode === 'draining' &&
        runtimeKnown &&
        activeMatches.total === 0 &&
        liveReservations.total === 0 &&
        waitingTickets.total === 0 &&
        pendingResults.total === 0,
    };
  });
}

/**
 * 进入排空维护：在 `FOR UPDATE` 下进行版本 CAS 比对、翻转模式、自增版本号，并删除所有仍处于等待中的队列票据
 * （它们属于瞬时意图而非用户持久资产，否则会使排空屏障永远无法通过）。
 * 当已处于排空维护状态，或基于陈旧版本号操作时，均会被拒绝——调用方必须重新读取再做决策，绝不允许意外胜出。
 */
export async function enterMaintenance(
  database: Database,
  expectedRevision: number,
): Promise<MaintenanceInfo> {
  return database.transaction(async (tx) => {
    const control = await lockControl(tx, 'update');
    if (control.revision !== expectedRevision) {
      throw new MaintenanceConflict('维护版本已变化，请重新读取维护状态后再试。');
    }
    if (control.mode === 'draining') {
      throw new MaintenanceConflict('已处于维护状态，不能重复进入维护。');
    }
    const now = await databaseNow(tx);
    await tx.delete(matchTickets).where(eq(matchTickets.state, 'waiting'));
    const [updated] = await tx
      .update(runtimeControl)
      .set({ mode: 'draining', revision: control.revision + 1, updated_at: now })
      .where(eq(runtimeControl.singleton, 1))
      .returning();
    return { mode: updated.mode, revision: updated.revision, updatedAt: updated.updated_at };
  });
}

/**
 * 退出排空状态——系统重新开放的唯一途径。与进入维护时保持相同的 `FOR UPDATE` 行锁，
 * 且必须满足：版本 CAS 正确、存在存活的运行时租约、以及传入该租约确切的 `runtime_epoch` 作为
 * 调用方证明其所恢复的具体是哪一代运行时的凭据。若无世代号证明，过期的运维请求可能会误将系统开放给
 * 一个从未巡检过的后继运行时；有了它，只有亲眼观察到当前运行时健康的运维操作方能恢复开放。
 */
export async function leaveMaintenance(
  database: Database,
  expectedRevision: number,
  expectedRuntimeEpoch: number,
): Promise<MaintenanceInfo> {
  return database.transaction(async (tx) => {
    const control = await lockControl(tx, 'update');
    if (control.revision !== expectedRevision) {
      throw new MaintenanceConflict('维护版本已变化，请重新读取维护状态后再试。');
    }
    if (control.mode === 'open') {
      throw new MaintenanceConflict('当前未处于维护状态，无需恢复开放。');
    }
    const now = await databaseNow(tx);
    const leaseLive =
      control.runtime_id !== null && control.lease_until !== null && control.lease_until > now;
    if (!leaseLive) {
      throw new MaintenanceConflict('尚无存活的运行时实例持有租约，不能恢复开放。');
    }
    if (control.runtime_epoch !== expectedRuntimeEpoch) {
      throw new MaintenanceConflict(
        `运行时已更换（当前第 ${control.runtime_epoch} 代），请确认存活实例后再恢复开放。`,
      );
    }
    const [updated] = await tx
      .update(runtimeControl)
      .set({ mode: 'open', revision: control.revision + 1, updated_at: now })
      .where(eq(runtimeControl.singleton, 1))
      .returning();
    return { mode: updated.mode, revision: updated.revision, updatedAt: updated.updated_at };
  });
}

/**
 * 状态变更事务内部的持久化准入校验：在控制行上加 `FOR SHARE` 共享锁（使得并发的进入/退出维护操作
 * 必须等待本事务完成，而不会产生竞态），并在缺失控制行或处于排空维护模式时故障阻断拒绝。
 * 这是房间或匹配事务获取的第一个锁；房间行与票据行只能在它之后加锁，绝不能在此之前。
 */
export async function assertAdmission(tx: Transaction): Promise<void> {
  const control = await lockControl(tx, 'share');
  if (control.mode === 'draining') {
    throw new MaintenanceError('maintenance:draining');
  }
}

/**
 * 在准入事务中执行 `fn`：控制行在整个回调期间保持共享锁定，因此新资源的提交必定处于数据库原子担保的模式之下。
 * 房间创建与对局匹配配对均采用这种模式（直接调用或内联实现）。
 */
export function withAdmission<T>(
  database: Database,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    await assertAdmission(tx);
    return fn(tx);
  });
}
