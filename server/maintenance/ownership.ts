import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { MaintenanceError } from '../../shared/maintenance';
import type { Database, Transaction } from '../db';
import { runtimeControl } from '../db/schema';

/**
 * Runtime ownership of the one global game runtime.
 *
 * Exactly one process may drive rooms, and "which process" must survive process restarts,
 * crash-then-restart duplicates and containers that happen to share a Compose name. The
 * `runtime_control` row is the ownership record: `runtime_id` is the current owner's token,
 * `runtime_epoch` is a monotonic global generation, and `lease_until` — compared against the
 * database's own clock — bounds how long that record stays trustworthy.
 *
 * - `acquireRuntime` claims the row under `FOR UPDATE`: a fresh claim or an expired-lease
 *   takeover bumps the epoch; a duplicate that arrives while a valid lease is held is refused
 *   until the lease genuinely expires (crashed owners are restarted by the operator, never
 *   raced). An expired lease is never revived — resumption takes a fresh epoch.
 * - `assert(tx)` is the write fence. Every room mutation transaction opens with it: it locks the
 *   control row, reads the lease with a fresh database clock, and throws unless this exact token
 *   still owns this exact epoch on an unexpired lease — so a late heartbeat, a zombie async
 *   callback or a post-outage owner whose lease lapsed can never write.
 * - The heartbeat only *renews*: it refuses when the lease has already lapsed or been taken
 *   over, and fires `onLost` in those cases instead of resurrecting lost ownership. A
 *   stand-down owner rejoins only by calling `acquireRuntime` again, which takes a fresh epoch.
 * - `close()` releases the lease only if it is still ours.
 *
 * Timing rule: `now()` is frozen at transaction start and goes stale across lock waits, so every
 * clock read here is `clock_timestamp()` executed AFTER the row lock. Lock order: this module
 * touches the control row only; callers take it first (via `assert`) and only then lock rooms
 * and tickets.
 */

/** How long a lease lasts without a heartbeat, measured on the database clock. */
const LEASE_MS = 30_000;

/** The lease was taken over or lapsed: stand down immediately. */
export class RuntimeOwnershipLostError extends Error {
  constructor(epoch: number) {
    super(`运行时所有权（第 ${epoch} 代）已经丢失，本次写入被拒绝。`);
    this.name = 'RuntimeOwnershipLostError';
  }
}

/** Another live owner holds the lease: a duplicate process, not a lost one. */
export class RuntimeOwnershipBusyError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'RuntimeOwnershipBusyError';
    this.retryable = retryable;
  }
}

/** The write fence the room runtime asserts inside every mutation transaction. */
export interface RuntimeOwnership {
  readonly epoch: number;
  /** Throws `RuntimeOwnershipLostError` unless this token still owns a live lease. Locks the row. */
  assert(tx: Transaction): Promise<void>;
  /** Releases the lease when it is still ours; idempotent, never touches a successor's lease. */
  close(): Promise<void>;
}

export interface AcquireRuntimeOptions {
  /** Fired once when the heartbeat discovers the lease is gone. Must stand the runtime down. */
  onLost?: () => void;
  leaseMs?: number;
  heartbeatMs?: number;
}

interface OwnedRow {
  runtime_id: string | null;
  runtime_epoch: number;
  lease_until: number | null;
}

/** Locks the control row exclusively, then reads its ownership record with a fresh database clock. */
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
 * The lease record under a shared lock plus a fresh database clock read afterwards. `assert`
 * uses this instead of the exclusive read: many room transactions may hold `FOR SHARE` on the
 * control row at once — each then serializes on its own room row — while the shared lock still
 * blocks every takeover and heartbeat transition until the room transaction commits. It is the
 * first lock a room transaction takes, so an exclusive holder can never wait on a room row this
 * transaction already holds.
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
      // A throwing handler must not break the heartbeat loop; ownership is already lost.
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
        // Renew-only: a lapsed or taken-over lease means ownership is already gone; the row is
        // never resurrected from here.
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
      // Transient database failure: mutations fail closed through `assert` anyway and the lease
      // simply lapses if the outage outlasts it. The next beat retries.
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
        // The database is unreachable at shutdown; the lease lapses on its own and a restart
        // takes over after expiry. Nothing can be claimed truthfully here.
      }
    },
  };
}
