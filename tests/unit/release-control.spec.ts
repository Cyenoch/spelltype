import { afterEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../server/db';
import type { Database, OpenedDatabase, Transaction } from '../../server/db';
import {
  accounts,
  matchTickets,
  releaseControl,
  releaseVersions,
  rooms,
} from '../../server/db/schema';
import {
  activateRelease,
  checkRelease,
  completeRetirement,
  ensureDevelopmentRelease,
  getReleaseInfo,
  getReleaseState,
  probeRetirement,
  stageRelease,
  withAdmission,
} from '../../server/releases/control';
import {
  acquireRuntime,
  RuntimeOwnershipBusyError,
  type RuntimeOwnership,
} from '../../server/releases/ownership';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccccccccccccccccccc';
const ROOM = 'a1b2c3d4e5f6a7b8c9d0e1f2';
const ROOM2 = 'f2e1d0c9b8a7f6e5d4c3b2a1';
const NOW = 1_700_000_000_000;

const dbs: OpenedDatabase[] = [];
const leases: RuntimeOwnership[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.close();
  for (const opened of dbs.splice(0)) await opened.close();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const conflict = { name: 'ReleaseConflict' };

async function open(): Promise<Database> {
  const opened = await openDatabase('pglite://:memory:');
  dbs.push(opened);
  return opened.db;
}

async function seedAccount(db: Database, id: string) {
  await db.insert(accounts).values({
    id,
    username: `user-${id.slice(0, 6)}`,
    username_key: `user-${id.slice(0, 6)}`,
    password_hash: 'x',
    created_at: NOW,
  });
}

async function seedVersion(
  db: Database,
  id: string,
  over: Partial<{ digest: string; state: 'staged' | 'active' | 'retiring' | 'retired' }> = {},
) {
  await db.insert(releaseVersions).values({
    id,
    state: over.state ?? 'staged',
    artifact_digest: over.digest ?? `digest-${id.slice(0, 4)}`,
    operation_id: `op-${id.slice(0, 4)}`,
    created_at: NOW,
    updated_at: NOW,
  });
}

async function checkOwn(db: Database, releaseId: string, operationId: string) {
  const lease = await acquireRuntime(db, releaseId);
  leases.push(lease);
  await checkRelease(db, { operationId, releaseId }, async (checked) => ({
    releaseId: checked,
    runtimeEpoch: lease.epoch,
  }));
  return lease;
}

/** Stage (inserting or adopting) plus health-check B. */
async function stageOwn(db: Database, releaseId: string, digest: string, operationId: string) {
  await stageRelease(db, { operationId, releaseId, artifactDigest: digest });
  return checkOwn(db, releaseId, operationId);
}

/** Active A (via the dev bootstrap) plus the accounts the tests address. */
async function admissionDb(...userIds: string[]) {
  const db = await open();
  await ensureDevelopmentRelease(db, A);
  for (const id of userIds) await seedAccount(db, id);
  return db;
}

/** Stage/check/activate B over an active A; keeps B's runtime lease alive. */
async function switchToB(db: Database, expectedReleaseId: string | null = A) {
  const lease = await stageOwn(db, B, 'digest-b', 'op-b');
  return {
    lease,
    activation: await activateRelease(db, {
      operationId: 'op-b',
      releaseId: B,
      expectedReleaseId,
    }),
  };
}

async function seedRoom(
  db: Database,
  roomId: string,
  releaseId: string,
  over: Partial<{
    phase: 'lobby' | 'generating' | 'countdown' | 'playing' | 'finished';
    reservation_state: 'none' | 'reserved' | 'cancelled' | 'expired' | 'locked';
    reservation_expires_at: number | null;
    persistence: 'idle' | 'saving' | 'saved' | 'error';
    draining: boolean;
    mode: 'private' | 'quick';
  }> = {},
) {
  await db.insert(rooms).values({
    id: roomId,
    release_id: releaseId,
    host_id: 'u1',
    mode: over.mode ?? 'quick',
    theme: '主题',
    difficulty: 'hard',
    phase: over.phase ?? 'lobby',
    reservation_state: over.reservation_state ?? 'none',
    reservation_expires_at: over.reservation_expires_at ?? null,
    persistence: over.persistence ?? 'idle',
    draining: over.draining ?? false,
    created_at: NOW,
    updated_at: NOW,
  });
}

async function seedTicket(
  db: Database,
  userId: string,
  releaseId: string,
  state: 'waiting' | 'matched',
  over: Partial<{ roomId: string | null; expiresAt: number }> = {},
) {
  await db.insert(matchTickets).values({
    user_id: userId,
    request_id: `req-${userId}`,
    release_id: releaseId,
    username: `user-${userId.slice(0, 6)}`,
    state,
    room_id: over.roomId ?? null,
    expires_at: over.expiresAt ?? Date.now() + 60_000,
    created_at: NOW,
    updated_at: NOW,
  });
}

describe('开发引导与公开指针', () => {
  it('空库没有指针，读指针返回 503 形状的失败', async () => {
    const db = await open();
    const failure = await getReleaseInfo(db).catch((error) => error);
    expect(failure).toMatchObject({
      name: 'ReleaseError',
      code: 'release:unavailable',
      status: 503,
    });
  });

  it('ensureDevelopmentRelease 幂等建指针；换版本被拒绝', async () => {
    const db = await open();
    await ensureDevelopmentRelease(db, A);
    await ensureDevelopmentRelease(db, A);
    expect(await getReleaseInfo(db)).toEqual({ activeReleaseId: A, updatedAt: expect.any(Number) });
    const state = await getReleaseState(db);
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]).toMatchObject({ id: A, state: 'active', admission_epoch: 1 });
    const refusal = await ensureDevelopmentRelease(db, B).catch((error) => error);
    expect(refusal).toMatchObject(conflict);
    expect((await getReleaseInfo(db)).activeReleaseId).toBe(A);
  });

  it('withAdmission 放行当前版本并在同一事务提交；其他版本拒绝且不执行', async () => {
    const db = await admissionDb('u1');
    let ran = false;
    const marked = await withAdmission(db, A, async (tx) => {
      ran = true;
      await seedRoomTx(tx, ROOM);
      return 'ok';
    });
    expect(marked).toBe('ok');
    expect(ran).toBe(true);
    expect(await db.select().from(rooms)).toHaveLength(1);

    let refusedRan = false;
    const refused = await withAdmission(db, B, async () => {
      refusedRan = true;
      return 'nope';
    }).catch((error) => error);
    expect(refusedRan).toBe(false);
    expect(refused).toMatchObject({
      name: 'ReleaseError',
      code: 'release:update_required',
      status: 409,
      activeReleaseId: A,
    });

    await withAdmission(db, A, async (tx) => {
      await seedRoomTx(tx, ROOM2);
      throw new Error('rollback');
    }).catch(() => undefined);
    expect(await db.select().from(rooms)).toHaveLength(1);
  });
});

async function seedRoomTx(tx: Transaction, roomId: string) {
  await tx.insert(rooms).values({
    id: roomId,
    release_id: A,
    host_id: 'u1',
    mode: 'private',
    theme: '主题',
    difficulty: 'hard',
    phase: 'lobby',
    created_at: NOW,
    updated_at: NOW,
  });
}

describe('stage 与 check', () => {
  it('staging 幂等；同版本不同摘要永不接受；新操作可接管仍处 staged 的版本', async () => {
    const db = await open();
    await stageRelease(db, { operationId: 'op1', releaseId: B, artifactDigest: 'digest-b' });
    await stageRelease(db, { operationId: 'op1', releaseId: B, artifactDigest: 'digest-b' });
    const state = await getReleaseState(db);
    expect(state.versions).toHaveLength(1);
    expect(state.versions[0]).toMatchObject({ id: B, state: 'staged', operation_id: 'op1' });

    const digestClash = await stageRelease(db, {
      operationId: 'op1',
      releaseId: B,
      artifactDigest: 'other-bytes',
    }).catch((error) => error);
    expect(digestClash).toMatchObject(conflict);

    const adopted = await stageRelease(db, {
      operationId: 'op2',
      releaseId: B,
      artifactDigest: 'digest-b',
    });
    expect(adopted.operation_id).toBe('op2');
  });

  it('已激活版本同操作重放返回现状，异操作拒绝', async () => {
    const db = await admissionDb();
    await switchToB(db);

    const staged = await stageRelease(db, {
      operationId: 'op-b',
      releaseId: B,
      artifactDigest: 'digest-b',
    });
    expect(staged.state).toBe('active');
    const stageRefusal = await stageRelease(db, {
      operationId: 'op-c',
      releaseId: B,
      artifactDigest: 'digest-b',
    }).catch((error) => error);
    expect(stageRefusal).toMatchObject(conflict);

    const replay = await activateRelease(db, {
      operationId: 'op-b',
      releaseId: B,
      expectedReleaseId: A,
    });
    expect(replay.info.activeReleaseId).toBe(B);
    expect(replay.previousReleaseId).toBe(B);
    const before = await getReleaseState(db);

    await stageOwn(db, C, 'digest-c', 'op-c');
    const stale = await activateRelease(db, {
      operationId: 'op-c',
      releaseId: C,
      expectedReleaseId: A,
    }).catch((error) => error);
    expect(stale).toMatchObject(conflict);
    const after = await getReleaseState(db);
    expect(after.control!.revision).toBe(before.control!.revision);
    expect(after.control!.active_release_id).toBe(B);
  });

  it('check 校验探针身份与当前租约，落 checked_epoch；租约失效或代次不符拒绝', async () => {
    const db = await open();
    await seedVersion(db, B, { digest: 'digest-b' });
    await stageRelease(db, { operationId: 'op-b', releaseId: B, artifactDigest: 'digest-b' });

    const wrongIdentity = await checkRelease(
      db,
      { operationId: 'op-b', releaseId: B },
      async () => ({
        releaseId: A,
        runtimeEpoch: 1,
      }),
    ).catch((error) => error);
    expect(wrongIdentity).toMatchObject(conflict);

    const lease = await acquireRuntime(db, B, { leaseMs: 40, heartbeatMs: 60_000 });
    leases.push(lease);
    const staleEpoch = await checkRelease(db, { operationId: 'op-b', releaseId: B }, async () => ({
      releaseId: B,
      runtimeEpoch: 99,
    })).catch((error) => error);
    expect(staleEpoch).toMatchObject(conflict);

    const checked = await checkRelease(db, { operationId: 'op-b', releaseId: B }, async (r) => ({
      releaseId: r,
      runtimeEpoch: lease.epoch,
    }));
    expect(checked.checked_epoch).toBe(lease.epoch);
    expect(checked.operation_id).toBe('op-b');

    await sleep(60);
    const lapsed = await checkRelease(db, { operationId: 'op-b', releaseId: B }, async (r) => ({
      releaseId: r,
      runtimeEpoch: lease.epoch,
    })).catch((error) => error);
    expect(lapsed).toMatchObject(conflict);
  });

  it('重复获取租约被拒绝，直到租约真正过期后以新代次接管', async () => {
    const db = await open();
    await seedVersion(db, B, { digest: 'digest-b' });
    await stageRelease(db, { operationId: 'op-b', releaseId: B, artifactDigest: 'digest-b' });
    const first = await acquireRuntime(db, B, { leaseMs: 40, heartbeatMs: 60_000 });
    leases.push(first);
    const busy = await acquireRuntime(db, B, { leaseMs: 40, heartbeatMs: 60_000 }).catch(
      (error) => error,
    );
    expect(busy).toBeInstanceOf(RuntimeOwnershipBusyError);
    await sleep(60);
    const second = await acquireRuntime(db, B, { leaseMs: 40, heartbeatMs: 60_000 });
    leases.push(second);
    expect(second.epoch).toBe(first.epoch + 1);
    const missing = await acquireRuntime(db, C).catch((error) => error);
    expect(missing).toMatchObject({ name: 'ReleaseError', code: 'release:unavailable' });
  });
});

describe('激活 CAS 与切换', () => {
  it('未健康检查的版本不能激活；完成后指针、生命周期与房间/票证清理一次到位', async () => {
    const db = await admissionDb('u1', 'u2');
    await seedVersion(db, B, { digest: 'digest-b' });
    await stageRelease(db, { operationId: 'op-b', releaseId: B, artifactDigest: 'digest-b' });
    const unchecked = await activateRelease(db, {
      operationId: 'op-b',
      releaseId: B,
      expectedReleaseId: A,
    }).catch((error) => error);
    expect(unchecked).toMatchObject(conflict);

    await seedRoom(db, ROOM, A, { phase: 'playing', reservation_state: 'locked' });
    await seedTicket(db, 'u1', A, 'waiting');
    await seedTicket(db, 'u2', A, 'matched', { roomId: ROOM, expiresAt: NOW + 60_000 });

    leases.push(await acquireRuntime(db, B));
    await checkRelease(db, { operationId: 'op-b', releaseId: B }, async (r) => ({
      releaseId: r,
      runtimeEpoch: 1,
    }));
    const result = await activateRelease(db, {
      operationId: 'op-b',
      releaseId: B,
      expectedReleaseId: A,
    });
    expect(result.info.activeReleaseId).toBe(B);
    expect(result.previousReleaseId).toBe(A);

    const state = await getReleaseState(db);
    expect(state.control).toMatchObject({ active_release_id: B, revision: 2 });
    const byId = new Map(state.versions.map((version) => [version.id, version]));
    expect(byId.get(A)).toMatchObject({ state: 'retiring', admission_epoch: 1 });
    expect(byId.get(B)).toMatchObject({ state: 'active', admission_epoch: 1 });

    const frozen = await db.select().from(rooms).where(eq(rooms.id, ROOM));
    expect(frozen[0].draining).toBe(true);

    const tickets = await db.select().from(matchTickets);
    expect(tickets).toHaveLength(1);
    expect(tickets[0]).toMatchObject({ state: 'matched', room_id: ROOM });
  });

  it('同参数重放幂等返回；CAS 前置版本不符拒绝且状态不变', async () => {
    const db = await admissionDb();
    await switchToB(db);
    const replay = await activateRelease(db, {
      operationId: 'op-b',
      releaseId: B,
      expectedReleaseId: A,
    });
    expect(replay.info.activeReleaseId).toBe(B);
    expect(replay.previousReleaseId).toBe(B);
    const before = await getReleaseState(db);

    await stageOwn(db, C, 'digest-c', 'op-c');
    const stale = await activateRelease(db, {
      operationId: 'op-c',
      releaseId: C,
      expectedReleaseId: A,
    }).catch((error) => error);
    expect(stale).toMatchObject(conflict);
    const after = await getReleaseState(db);
    expect(after.control!.revision).toBe(before.control!.revision);
    expect(after.control!.active_release_id).toBe(B);
  });

  it('首个版本以 expectedReleaseId=null 激活并创建控制行；CAS 不符不能旁路', async () => {
    const db = await open();
    await switchToB(db, null);
    expect(await getReleaseInfo(db)).toMatchObject({ activeReleaseId: B });

    await stageOwn(db, C, 'digest-c', 'op-c');
    const asFirst = await activateRelease(db, {
      operationId: 'op-c',
      releaseId: C,
      expectedReleaseId: null,
    }).catch((error) => error);
    expect(asFirst).toMatchObject(conflict);
    expect((await getReleaseInfo(db)).activeReleaseId).toBe(B);
  });
});

describe('回退与退休屏障', () => {
  it('回退重新激活提升准入代次并解冻，旧证据被封存拒绝', async () => {
    const db = await admissionDb();
    await switchToB(db);
    const probeBefore = await probeRetirement(db, A);
    expect(probeBefore).toMatchObject({
      releaseId: A,
      state: 'retiring',
      admissionEpoch: 1,
      ready: true,
    });

    await checkOwn(db, A, 'op-a-rollback');
    const rollback = await activateRelease(db, {
      operationId: 'op-a-rollback',
      releaseId: A,
      expectedReleaseId: B,
    });
    expect(rollback.info.activeReleaseId).toBe(A);
    expect(rollback.previousReleaseId).toBe(B);

    const state = await getReleaseState(db);
    const byId = new Map(state.versions.map((version) => [version.id, version]));
    expect(byId.get(A)).toMatchObject({ state: 'active', admission_epoch: 2 });
    expect(byId.get(B)).toMatchObject({ state: 'retiring', admission_epoch: 1 });

    const staleProof = await completeRetirement(db, { releaseId: A, admissionEpoch: 1 }).catch(
      (error) => error,
    );
    expect(staleProof).toMatchObject(conflict);
    const stillActive = await completeRetirement(db, { releaseId: A, admissionEpoch: 2 }).catch(
      (error) => error,
    );
    expect(stillActive).toMatchObject(conflict);
  });

  it('回退时新版本的房间被冻结而旧版本房间解冻', async () => {
    const db = await admissionDb();
    await seedRoom(db, ROOM, A);
    await switchToB(db);
    expect((await db.select().from(rooms).where(eq(rooms.id, ROOM)))[0].draining).toBe(true);
    await seedRoom(db, ROOM2, B);

    await checkOwn(db, A, 'op-a-rollback');
    await activateRelease(db, {
      operationId: 'op-a-rollback',
      releaseId: A,
      expectedReleaseId: B,
    });
    expect((await db.select().from(rooms).where(eq(rooms.id, ROOM)))[0].draining).toBe(false);
    expect((await db.select().from(rooms).where(eq(rooms.id, ROOM2)))[0].draining).toBe(true);
  });

  it('进行中对局、未落定结果、排队记录与未完成预约都阻止封存，逐一解除后可封存', async () => {
    const db = await admissionDb('u1');
    await switchToB(db);

    await seedRoom(db, ROOM, A, { phase: 'playing', reservation_state: 'locked' });
    let probe = await probeRetirement(db, A);
    expect(probe).toMatchObject({ state: 'retiring', activeMatches: 1, ready: false });
    const sealedEarly = await completeRetirement(db, {
      releaseId: A,
      admissionEpoch: probe.admissionEpoch,
    }).catch((error) => error);
    expect(sealedEarly).toMatchObject(conflict);

    await db
      .update(rooms)
      .set({ phase: 'finished', persistence: 'saving' })
      .where(eq(rooms.id, ROOM));
    probe = await probeRetirement(db, A);
    expect(probe).toMatchObject({ activeMatches: 0, pendingResults: 1, ready: false });

    await db.update(rooms).set({ persistence: 'saved' }).where(eq(rooms.id, ROOM));
    await seedTicket(db, 'u1', A, 'waiting');
    probe = await probeRetirement(db, A);
    expect(probe).toMatchObject({ waitingTickets: 1, ready: false });

    await db.delete(matchTickets).where(eq(matchTickets.user_id, 'u1'));
    await seedRoom(db, ROOM2, A, {
      reservation_state: 'reserved',
      reservation_expires_at: Date.now() + 60_000,
    });
    probe = await probeRetirement(db, A);
    expect(probe).toMatchObject({ liveReservations: 1, ready: false });

    await db
      .update(rooms)
      .set({ reservation_expires_at: NOW - 1 })
      .where(eq(rooms.id, ROOM2));
    probe = await probeRetirement(db, A);
    expect(probe).toMatchObject({ liveReservations: 0, ready: true, runtimeKnown: true });

    const sealed = await completeRetirement(db, {
      releaseId: A,
      admissionEpoch: probe.admissionEpoch,
    });
    expect(sealed.state).toBe('retired');
    const replay = await completeRetirement(db, {
      releaseId: A,
      admissionEpoch: probe.admissionEpoch,
    });
    expect(replay.state).toBe('retired');
    const revive = await activateRelease(db, {
      operationId: 'op-a-rollback',
      releaseId: A,
      expectedReleaseId: B,
    }).catch((error) => error);
    expect(revive).toMatchObject(conflict);
  });

  it('租约失效未释放的运行时是未知状态，阻止封存；正常释放后即可封存', async () => {
    const db = await admissionDb();
    await switchToB(db);
    const dying = await acquireRuntime(db, A, { leaseMs: 30, heartbeatMs: 60_000 });
    leases.push(dying);
    await sleep(60);
    const probe = await probeRetirement(db, A);
    expect(probe.runtimeKnown).toBe(false);
    expect(probe.ready).toBe(false);
    const refused = await completeRetirement(db, {
      releaseId: A,
      admissionEpoch: probe.admissionEpoch,
    }).catch((error) => error);
    expect(refused).toMatchObject(conflict);

    await dying.close();
    const recovered = await probeRetirement(db, A);
    expect(recovered.runtimeKnown).toBe(true);
    expect(recovered.ready).toBe(true);
  });

  it('probe 未知版本返回不可用；激活版本永不 ready', async () => {
    const db = await admissionDb();
    const missing = await probeRetirement(db, 'e'.repeat(32)).catch((error) => error);
    expect(missing).toMatchObject({ name: 'ReleaseError', code: 'release:unavailable' });
    const probe = await probeRetirement(db, A);
    expect(probe).toMatchObject({ state: 'active', ready: false });
  });
});

describe('控制行丢失', () => {
  it('控制行缺失时准入失败关闭', async () => {
    const db = await admissionDb();
    await db.delete(releaseControl);
    const pointer = await getReleaseInfo(db).catch((error) => error);
    expect(pointer).toMatchObject({ code: 'release:unavailable' });
    const refused = await withAdmission(db, A, async () => 'ok').catch((error) => error);
    expect(refused).toMatchObject({ name: 'ReleaseError', code: 'release:unavailable' });
  });
});
