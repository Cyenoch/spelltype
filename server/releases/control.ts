import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Phase } from '../../shared/protocol';
import { releaseIdSchema, ReleaseError } from '../../shared/release';
import type { ReleaseInfo, ReleaseState } from '../../shared/release';
import type { Database, Transaction } from '../db';
import {
  matchTickets,
  releaseControl,
  releaseVersions,
  rooms,
  type ReleaseControlRow,
  type ReleaseVersionRow,
} from '../db/schema';

/**
 * Release admission control.
 *
 * The database is the whole coordination story: `release_control` is the one admission pointer and
 * `release_versions` carries each version's lifecycle (`staged` → `active` → `retiring` →
 * `retired`) plus its runtime-ownership lease. Every rule below is a row lock plus a conditional
 * write, so two processes (or two deploy operations) can never both win:
 *
 * - Admission (`withAdmission`) takes a `FOR SHARE` lock on the control row and holds it until the
 *   new resource is committed. Activation takes `FOR UPDATE` on the same row, so it waits for every
 *   in-flight admission and, once it commits, every later admission sees the new pointer. There is
 *   no window where a room for the old release registers after the switch.
 * - Activation CASes the pointer (`expectedReleaseId`), retires the outgoing version, freezes its
 *   lobby rooms (`rooms.draining`) and deletes its still-waiting tickets — while *published* quick
 *   reservations keep their seats until their original TTL.
 * - Retirement is a barrier, not a timer: `probeRetirement` reports what still holds the release,
 *   and `completeRetirement` re-verifies every condition under a row lock before sealing. The
 *   evidence is bound to the version's `admission_epoch`; a rollback reactivation increments the
 *   epoch so a stale proof can never seal a live release.
 *
 * Lock order everywhere: control → release → room → ticket(s). Nothing waits for a network inside
 * these transactions; `checkRelease` runs its health probe before opening one.
 */

/** A deploy operation lost its race or its preconditions moved; the caller should re-read state. */
export class ReleaseConflict extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = 'ReleaseConflict';
  }
}

export interface StageReleaseInput {
  operationId: string;
  releaseId: string;
  artifactDigest: string;
}

export interface CheckReleaseInput {
  operationId: string;
  releaseId: string;
}

/** The health answer a game runtime gives about itself; delivered by the admin HTTP layer. */
export interface RuntimeHealth {
  releaseId: string;
  runtimeEpoch: number;
}

export interface ActivationInput {
  operationId: string;
  releaseId: string;
  /** CAS guard: the activation only proceeds if this is still the active release. `null` = first. */
  expectedReleaseId: string | null;
}

export interface ActivationResult {
  info: ReleaseInfo;
  previousReleaseId: string | null;
}

export interface CompleteRetirementInput {
  releaseId: string;
  admissionEpoch: number;
}

export interface ReleaseStateSnapshot {
  control: ReleaseControlRow | null;
  versions: ReleaseVersionRow[];
}

export interface RetirementProbe {
  releaseId: string;
  state: ReleaseState;
  admissionEpoch: number;
  /** Rooms in generating/countdown/playing: a live match the release still owns. */
  activeMatches: number;
  /** Quick rooms whose seat reservation is still within its TTL. */
  liveReservations: number;
  /** Still-waiting queue entries (normally swept at activation). */
  waitingTickets: number;
  /** Matched tickets inside their reservation window (informational; rooms decide the barrier). */
  liveMatchedTickets: number;
  /** Finished rooms whose result bookkeeping is not settled. */
  pendingResults: number;
  /** False when the release's runtime lease lapsed without a graceful release: unknown state. */
  runtimeKnown: boolean;
  ready: boolean;
}

function requireOperationId(operationId: string): string {
  const trimmed = operationId.trim();
  if (trimmed.length === 0 || trimmed.length > 128) {
    throw new ReleaseConflict('operationId 必须是 1—128 个字符');
  }
  return trimmed;
}

function requireDigest(artifactDigest: string): string {
  const trimmed = artifactDigest.trim();
  if (trimmed.length === 0 || trimmed.length > 256) {
    throw new ReleaseConflict('artifactDigest 必须是 1—256 个字符');
  }
  return trimmed;
}

/**
 * Database-authoritative wall time in milliseconds. `clock_timestamp`, not `now()`: the latter is
 * frozen at transaction start, which would go stale while a transaction waits on a row lock.
 */
export async function databaseNow(executor: Transaction): Promise<number> {
  const [row] = await executor
    .select({ now: sql<number>`(extract(epoch from clock_timestamp()) * 1000)`.mapWith(Number) })
    .from(releaseVersions)
    .limit(1);
  if (!row) throw new ReleaseError('release:unavailable');
  return Math.floor(row.now);
}

/** The admission pointer row, locked for share (readers) or update (changers). */
async function lockControl(
  tx: Transaction,
  mode: 'share' | 'update',
): Promise<ReleaseControlRow | null> {
  const query = tx.select().from(releaseControl).limit(1);
  const [row] = await (mode === 'share' ? query.for('share') : query.for('update'));
  return row ?? null;
}

async function lockVersion(tx: Transaction, releaseId: string): Promise<ReleaseVersionRow | null> {
  const [row] = await tx
    .select()
    .from(releaseVersions)
    .where(eq(releaseVersions.id, releaseId))
    .for('update');
  return row ?? null;
}

function runtimeLeaseValid(row: ReleaseVersionRow, now: number): boolean {
  return row.runtime_id !== null && row.lease_until !== null && row.lease_until > now;
}

/** `GET /api/release` — the public pointer, or a 503-shaped failure when nothing is active. */
export async function getReleaseInfo(database: Database): Promise<ReleaseInfo> {
  const [control] = await database.select().from(releaseControl).limit(1).for('share');
  if (!control || control.active_release_id === null) {
    throw new ReleaseError('release:unavailable');
  }
  return { activeReleaseId: control.active_release_id, updatedAt: control.updated_at };
}

/** Full admin view: the pointer plus every version's lifecycle row. */
export async function getReleaseState(database: Database): Promise<ReleaseStateSnapshot> {
  const [control] = await database.select().from(releaseControl).limit(1);
  const versions = await database
    .select()
    .from(releaseVersions)
    .orderBy(asc(releaseVersions.created_at), asc(releaseVersions.id));
  return { control: control ?? null, versions };
}

/**
 * Runs `fn` inside the admission transaction: the control row is share-locked, the pointer and the
 * version's lifecycle are verified, and the lock is held until `fn`'s writes commit. Room creation
 * and matchmaking pairing both go through here, which is what makes the A/B switch atomic against
 * every "read active, then create" race.
 */
export async function withAdmission<T>(
  database: Database,
  releaseId: string,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    const control = await lockControl(tx, 'share');
    if (!control || control.active_release_id === null) {
      throw new ReleaseError('release:unavailable');
    }
    if (control.active_release_id !== releaseId) {
      throw new ReleaseError('release:update_required', control.active_release_id);
    }
    const [version] = await tx
      .select({ state: releaseVersions.state })
      .from(releaseVersions)
      .where(eq(releaseVersions.id, releaseId))
      .limit(1);
    if (!version || version.state !== 'active') {
      // The pointer and the lifecycle are written in one transaction, so this only fires on a
      // broken database; fail closed rather than admit into an unknown state.
      throw new ReleaseError('release:unavailable');
    }
    return fn(tx);
  });
}

/**
 * Registers a build under its identity. The artifact digest of a version is immutable forever: a
 * same-id redelivery with different bytes is refused instead of silently re-staged. A staged
 * version may be adopted by a new operation (a previous deploy attempt that never activated); a
 * version that already advanced may only be re-staged by its own operation (a lost response).
 */
export async function stageRelease(
  database: Database,
  input: StageReleaseInput,
): Promise<ReleaseVersionRow> {
  const releaseId = releaseIdSchema.parse(input.releaseId);
  const operationId = requireOperationId(input.operationId);
  const artifactDigest = requireDigest(input.artifactDigest);
  const now = Date.now();

  return database.transaction(async (tx) => {
    const existing = await lockVersion(tx, releaseId);
    if (existing) return adoptOrRefuseStaged(tx, existing, operationId, artifactDigest, now);
    const [inserted] = await tx
      .insert(releaseVersions)
      .values({
        id: releaseId,
        state: 'staged',
        artifact_digest: artifactDigest,
        operation_id: operationId,
        admission_epoch: 0,
        created_at: now,
        updated_at: now,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    const raced = await lockVersion(tx, releaseId);
    if (!raced) throw new ReleaseError('release:unavailable');
    return adoptOrRefuseStaged(tx, raced, operationId, artifactDigest, now);
  });
}

async function adoptOrRefuseStaged(
  tx: Transaction,
  existing: ReleaseVersionRow,
  operationId: string,
  artifactDigest: string,
  now: number,
): Promise<ReleaseVersionRow> {
  if (existing.artifact_digest !== artifactDigest) {
    throw new ReleaseConflict(`版本 ${existing.id} 的产物摘要不可更改`);
  }
  if (existing.state === 'staged') {
    if (existing.operation_id === operationId) return existing;
    const [adopted] = await tx
      .update(releaseVersions)
      .set({ operation_id: operationId, updated_at: now })
      .where(and(eq(releaseVersions.id, existing.id), eq(releaseVersions.state, 'staged')))
      .returning();
    return adopted ?? existing;
  }
  if (existing.operation_id === operationId) return existing;
  throw new ReleaseConflict(`版本 ${existing.id} 已处于 ${existing.state} 状态，不能重新 staging`);
}

/**
 * Health-checks a staged (or rollback-target retiring) version against its live runtime. The probe
 * runs before the transaction opens — no network inside SQL locks — and the transaction then
 * verifies the answer still describes the runtime that currently holds the lease. The stored
 * `checked_epoch` is what `activateRelease` requires: a runtime restart invalidates the check.
 */
export async function checkRelease(
  database: Database,
  input: CheckReleaseInput,
  probe: (releaseId: string) => Promise<RuntimeHealth>,
): Promise<ReleaseVersionRow> {
  const releaseId = releaseIdSchema.parse(input.releaseId);
  const operationId = requireOperationId(input.operationId);
  const health = await probe(releaseId);
  if (health.releaseId !== releaseId) {
    throw new ReleaseConflict('运行时报告的版本与目标版本不一致');
  }
  if (!Number.isInteger(health.runtimeEpoch) || health.runtimeEpoch < 0) {
    throw new ReleaseConflict('运行时报告的 ownership 代次无效');
  }

  return database.transaction(async (tx) => {
    const version = await lockVersion(tx, releaseId);
    if (!version) throw new ReleaseError('release:unavailable');
    if (version.state !== 'staged' && version.state !== 'retiring') {
      throw new ReleaseConflict(`版本处于 ${version.state} 状态，无需健康检查`);
    }
    const now = await databaseNow(tx);
    if (!runtimeLeaseValid(version, now) || version.runtime_epoch !== health.runtimeEpoch) {
      throw new ReleaseConflict('目标运行时未持有有效租约或已更换，请重新检查');
    }
    const [checked] = await tx
      .update(releaseVersions)
      .set({
        operation_id: operationId,
        checked_epoch: health.runtimeEpoch,
        updated_at: Date.now(),
      })
      .where(eq(releaseVersions.id, releaseId))
      .returning();
    return checked;
  });
}

/**
 * The admission switch. CASes the pointer from `expectedReleaseId` (or from nothing when `null`)
 * to `releaseId`, marks the outgoing version `retiring`, freezes its lobby rooms and deletes its
 * waiting tickets — published quick reservations are intentionally kept until their own TTL. A
 * rollback is the same operation pointed at a `retiring` version: it reactivates it, increments
 * its admission epoch (so in-flight retirement proofs go stale) and unfreezes its rooms. Repeating
 * the same operation after a lost response returns the current state without changes.
 */
export async function activateRelease(
  database: Database,
  input: ActivationInput,
): Promise<ActivationResult> {
  const releaseId = releaseIdSchema.parse(input.releaseId);
  const operationId = requireOperationId(input.operationId);
  if (input.expectedReleaseId !== null) releaseIdSchema.parse(input.expectedReleaseId);

  return database.transaction(async (tx) => {
    const control = await lockControl(tx, 'update');
    const version = await lockVersion(tx, releaseId);
    if (!version) throw new ReleaseError('release:unavailable');
    if (version.operation_id !== operationId) {
      throw new ReleaseConflict('目标版本不属于该发布操作，请先 stage/check');
    }
    if (version.checked_epoch === null || version.checked_epoch !== version.runtime_epoch) {
      throw new ReleaseConflict('目标版本尚未通过当前运行实例的健康检查');
    }
    const now = await databaseNow(tx);
    if (!runtimeLeaseValid(version, now)) {
      throw new ReleaseConflict('目标版本运行时未持有有效租约');
    }

    const previousReleaseId = control?.active_release_id ?? null;
    if (previousReleaseId === releaseId) {
      return {
        info: { activeReleaseId: releaseId, updatedAt: control!.updated_at },
        previousReleaseId,
      };
    }
    if (version.state === 'retired') {
      throw new ReleaseConflict('已退役版本不能重新激活');
    }
    if (version.state !== 'staged' && version.state !== 'retiring') {
      throw new ReleaseConflict(`版本处于 ${version.state} 状态，不能激活`);
    }
    if (control) {
      if (input.expectedReleaseId === null) {
        if (previousReleaseId !== null)
          throw new ReleaseConflict('已存在激活版本，不能作为首个版本激活');
      } else if (previousReleaseId !== input.expectedReleaseId) {
        throw new ReleaseConflict('激活前置版本已变化，请重新读取发布状态');
      }
    } else if (input.expectedReleaseId !== null) {
      throw new ReleaseConflict('发布控制尚未初始化');
    }

    if (previousReleaseId !== null) {
      await tx
        .update(releaseVersions)
        .set({ state: 'retiring', updated_at: Date.now() })
        .where(and(eq(releaseVersions.id, previousReleaseId), eq(releaseVersions.state, 'active')));
      await freezeReleaseRooms(tx, previousReleaseId, true, now);
      await tx
        .delete(matchTickets)
        .where(
          and(eq(matchTickets.release_id, previousReleaseId), eq(matchTickets.state, 'waiting')),
        );
    }
    await tx
      .update(releaseVersions)
      .set({
        state: 'active',
        admission_epoch: sql`${releaseVersions.admission_epoch} + 1`,
        updated_at: Date.now(),
      })
      .where(eq(releaseVersions.id, releaseId));
    await freezeReleaseRooms(tx, releaseId, false, now);
    if (control) {
      await tx
        .update(releaseControl)
        .set({
          active_release_id: releaseId,
          revision: sql`${releaseControl.revision} + 1`,
          updated_at: now,
        })
        .where(eq(releaseControl.singleton, 1));
    } else {
      await tx
        .insert(releaseControl)
        .values({ singleton: 1, active_release_id: releaseId, revision: 1, updated_at: now });
    }
    return { info: { activeReleaseId: releaseId, updatedAt: now }, previousReleaseId };
  });
}

/** Lobby freeze flags. Outgoing release freezes; reactivated release unfreezes. */
async function freezeReleaseRooms(
  tx: Transaction,
  releaseId: string,
  draining: boolean,
  now: number,
): Promise<void> {
  await tx
    .update(rooms)
    .set({ draining, updated_at: now })
    .where(and(eq(rooms.release_id, releaseId), eq(rooms.draining, !draining)));
}

/**
 * Reports everything that still holds the release: live matches, live seat reservations, waiting
 * entries, unsettled results and unknown runtime state. A `retiring` (or never-activated) release's
 * rooms are re-asserted frozen in the same transaction, so a probe cannot race a host start into a
 * barrier the seal is about to rely on. The active release is never ready by definition.
 */
export async function probeRetirement(
  database: Database,
  releaseId: string,
): Promise<RetirementProbe> {
  const parsed = releaseIdSchema.parse(releaseId);
  return database.transaction(async (tx) => {
    const version = await lockVersion(tx, parsed);
    if (!version) throw new ReleaseError('release:unavailable');
    return retirementBarrier(tx, version, await databaseNow(tx));
  });
}

async function retirementBarrier(
  tx: Transaction,
  version: ReleaseVersionRow,
  now: number,
): Promise<RetirementProbe> {
  if (version.state !== 'active') {
    // Belt and braces: a version on its way out keeps its lobbies frozen even if an activation
    // raced a flag write; a never-activated version has no rooms to freeze but nothing to lose.
    await tx
      .update(rooms)
      .set({ draining: true, updated_at: Date.now() })
      .where(and(eq(rooms.release_id, version.id), eq(rooms.draining, false)));
  }
  const releaseId = version.id;
  const phases: Phase[] = ['generating', 'countdown', 'playing'];
  const [activeMatches] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(rooms)
    .where(and(eq(rooms.release_id, releaseId), inArray(rooms.phase, phases)));
  const [liveReservations] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(rooms)
    .where(
      and(
        eq(rooms.release_id, releaseId),
        eq(rooms.reservation_state, 'reserved'),
        sql`${rooms.reservation_expires_at} is not null and ${rooms.reservation_expires_at} > ${now}`,
      ),
    );
  const [waitingTickets] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(matchTickets)
    .where(and(eq(matchTickets.release_id, releaseId), eq(matchTickets.state, 'waiting')));
  const [liveMatchedTickets] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(matchTickets)
    .where(
      and(
        eq(matchTickets.release_id, releaseId),
        eq(matchTickets.state, 'matched'),
        sql`${matchTickets.expires_at} > ${now}`,
      ),
    );
  const [pendingResults] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(rooms)
    .where(and(eq(rooms.release_id, releaseId), sql`${rooms.persistence} in ('saving', 'error')`));
  const runtimeKnown = version.runtime_id === null || runtimeLeaseValid(version, now);
  const ready =
    version.state !== 'active' &&
    activeMatches.total === 0 &&
    liveReservations.total === 0 &&
    waitingTickets.total === 0 &&
    pendingResults.total === 0 &&
    runtimeKnown;
  return {
    releaseId,
    state: version.state,
    admissionEpoch: version.admission_epoch,
    activeMatches: activeMatches.total,
    liveReservations: liveReservations.total,
    waitingTickets: waitingTickets.total,
    liveMatchedTickets: liveMatchedTickets.total,
    pendingResults: pendingResults.total,
    runtimeKnown,
    ready,
  };
}

function describeBarrier(probe: RetirementProbe): string {
  const blockers: string[] = [];
  if (probe.activeMatches > 0) blockers.push(`${probe.activeMatches} 场进行中的对局`);
  if (probe.liveReservations > 0) blockers.push(`${probe.liveReservations} 个未完成的预约席位`);
  if (probe.waitingTickets > 0) blockers.push(`${probe.waitingTickets} 条排队记录`);
  if (probe.pendingResults > 0) blockers.push(`${probe.pendingResults} 间战绩未落定的房间`);
  if (!probe.runtimeKnown) blockers.push('运行时租约已失效且未正常释放（状态未知）');
  return blockers.length > 0 ? `退休屏障未满足：${blockers.join('，')}` : '退休屏障未满足';
}

/**
 * Seals a version retired. The barrier is re-verified under the version row lock — probe evidence
 * alone is never trusted — and the caller's `admissionEpoch` is CAS-checked, so a proof gathered
 * before a rollback reactivation cannot seal the release it no longer describes. Sealing an
 * already-retired version is idempotent; sealing the active release is refused.
 */
export async function completeRetirement(
  database: Database,
  input: CompleteRetirementInput,
): Promise<ReleaseVersionRow> {
  const releaseId = releaseIdSchema.parse(input.releaseId);
  return database.transaction(async (tx) => {
    const version = await lockVersion(tx, releaseId);
    if (!version) throw new ReleaseError('release:unavailable');
    if (version.state === 'retired') return version;
    if (version.state === 'active') {
      throw new ReleaseConflict('版本仍是当前准入目标，不能封存');
    }
    if (version.admission_epoch !== input.admissionEpoch) {
      throw new ReleaseConflict('退休证据已过期：版本准入代次已变化');
    }
    const probe = await retirementBarrier(tx, version, await databaseNow(tx));
    if (!probe.ready) throw new ReleaseConflict(describeBarrier(probe));
    const now = Date.now();
    const [sealed] = await tx
      .update(releaseVersions)
      .set({ state: 'retired', retired_at: now, updated_at: now })
      .where(
        and(
          eq(releaseVersions.id, releaseId),
          eq(releaseVersions.admission_epoch, input.admissionEpoch),
        ),
      )
      .returning();
    return sealed;
  });
}

/**
 * Local development bootstrap: point an empty (or already-matching) database at the fixed dev
 * release. It never bypasses production admission — callers only invoke it for the dev role — and
 * it refuses to repoint a database that is already aimed at another release.
 */
export async function ensureDevelopmentRelease(
  database: Database,
  releaseId: string,
): Promise<void> {
  const parsed = releaseIdSchema.parse(releaseId);
  const now = Date.now();
  await database.transaction(async (tx) => {
    const control = await lockControl(tx, 'update');
    if (control && control.active_release_id === parsed) return;
    if (control && control.active_release_id !== null) {
      throw new ReleaseConflict(
        `开发数据库已指向版本 ${control.active_release_id}，不能改指 ${parsed}`,
      );
    }
    const version = await lockVersion(tx, parsed);
    if (version) {
      if (version.state === 'retired') {
        throw new ReleaseConflict('开发数据库中的版本已退役，请清理本地数据目录');
      }
      if (version.state !== 'active') {
        await tx
          .update(releaseVersions)
          .set({
            state: 'active',
            admission_epoch: sql`${releaseVersions.admission_epoch} + 1`,
            updated_at: now,
          })
          .where(eq(releaseVersions.id, parsed));
      }
    } else {
      await tx.insert(releaseVersions).values({
        id: parsed,
        state: 'active',
        artifact_digest: 'development',
        operation_id: 'development',
        admission_epoch: 1,
        created_at: now,
        updated_at: now,
      });
    }
    if (control) {
      await tx
        .update(releaseControl)
        .set({
          active_release_id: parsed,
          revision: sql`${releaseControl.revision} + 1`,
          updated_at: now,
        })
        .where(eq(releaseControl.singleton, 1));
    } else {
      await tx
        .insert(releaseControl)
        .values({ singleton: 1, active_release_id: parsed, revision: 1, updated_at: now });
    }
  });
}
