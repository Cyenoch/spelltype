import { eq, inArray, sql } from 'drizzle-orm';
import { MaintenanceError, type DrainStatus, type MaintenanceInfo } from '../../shared/maintenance';
import type { Database, QueryDatabase, Transaction } from '../db';
import { matchTickets, rooms, runtimeControl, type RuntimeControlRow } from '../db/schema';

/**
 * Durable maintenance: admission, drain observation and the revision-CAS transitions.
 *
 * The one `runtime_control` row is the whole story. `mode` decides admission; `revision` is the
 * CAS token that makes every transition (`enterMaintenance`/`leaveMaintenance`) safe for racy
 * operators — a stale or repeated operation is refused with `MaintenanceConflict` (409), never
 * silently taken over. Drain readiness is computed, not asserted: the barrier counts are read
 * under the control-row lock, so an inspection can never miss work that is mid-admission.
 *
 * Lock order everywhere: runtime_control → rooms → tickets. Nothing waits for a network inside
 * these transactions, and every deadline comparison reads the database's own `clock_timestamp()`
 * AFTER the row lock — `now()` is frozen at transaction start and goes stale across lock waits.
 */

/** A maintenance transition lost its race or quoted a stale revision; re-read and retry. */
export class MaintenanceConflict extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceConflict';
  }
}

/**
 * Database-authoritative wall time in milliseconds, read after any row lock the caller holds.
 * Fails closed when the control row is missing: without it there is no state to vouch for.
 */
async function databaseNow(executor: QueryDatabase): Promise<number> {
  const [row] = await executor
    .select({ now: sql<number>`(extract(epoch from clock_timestamp()) * 1000)`.mapWith(Number) })
    .from(runtimeControl)
    .limit(1);
  if (!row) throw new MaintenanceError('maintenance:unavailable');
  return Math.floor(row.now);
}

/** The control row locked `FOR SHARE` (readers that must not race a transition) or `FOR UPDATE`. */
async function lockControl(tx: Transaction, mode: 'share' | 'update'): Promise<RuntimeControlRow> {
  const query = tx.select().from(runtimeControl).limit(1);
  const [row] = await (mode === 'share' ? query.for('share') : query.for('update'));
  if (!row) throw new MaintenanceError('maintenance:unavailable');
  return row;
}

/**
 * The maintenance pointer as it is committed right now — no lock, one MVCC read. Safe to call
 * with an open transaction (an in-transaction admission re-check) or the plain database.
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
 * Everything that still blocks reopening, counted under the control-row lock. The lock is what
 * makes the answer trustworthy: admissions (`FOR SHARE`) wait for it, so a match cannot start
 * between the counts and the verdict.
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
    // Idle sockets and lobby rooms are deliberately not blockers — draining stops NEW work.
    // A null owner is known state (nothing to vouch for); a lapsed lease without graceful
    // release is unknown state and blocks readiness until it is renewed or released.
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
 * Enters draining: revision CAS under `FOR UPDATE`, mode flipped, revision bumped, and every
 * still-waiting queue ticket deleted (they are intents, not user data, and each would otherwise
 * block the drain barrier forever). Entering while already draining, or against a stale
 * revision, is refused — the caller re-reads and decides, nobody wins by accident.
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
 * Leaves draining — the one way maintenance ever opens. Under the same `FOR UPDATE` as the flip
 * it requires: the revision CAS, a live runtime lease, and that lease's exact `runtime_epoch` as
 * the caller's proof of WHICH runtime is being resumed. Without the epoch proof a stale operator
 * could reopen maintenance for a successor runtime it never inspected; with it, only an operator
 * that observed the current runtime healthy can resume.
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
 * The durable admission check inside a mutation transaction: `FOR SHARE` on the control row (so
 * a concurrent enter/leave waits for this transaction instead of racing it) and a fail-closed
 * verdict — missing control row or draining mode both refuse. This is the first lock a room or
 * matchmaking transaction takes; rooms and tickets come after it, never before.
 */
export async function assertAdmission(tx: Transaction): Promise<void> {
  const control = await lockControl(tx, 'share');
  if (control.mode === 'draining') {
    throw new MaintenanceError('maintenance:draining');
  }
}

/**
 * Runs `fn` inside an admission transaction: the control row is share-locked for the whole
 * callback, so new resources commit only under a mode the database vouched for atomically.
 * Room creation and matchmaking pairing both go through this shape (directly or inline).
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
