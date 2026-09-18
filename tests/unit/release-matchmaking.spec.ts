import { afterEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../../server/db';
import type { Database, OpenedDatabase } from '../../server/db';
import {
  accounts,
  departures,
  matchTickets,
  players,
  releaseVersions,
  rooms,
} from '../../server/db/schema';
import { acquireMatch, cancelMatch } from '../../server/matchmaking';
import type { User } from '../../shared/protocol';
import {
  activateRelease,
  checkRelease,
  ensureDevelopmentRelease,
  stageRelease,
} from '../../server/releases/control';
import { acquireRuntime, type RuntimeOwnership } from '../../server/releases/ownership';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = 1_700_000_000_000;
const RESERVATION_TTL = 60_000;
const QUEUE_TTL = 60_000;

const dbs: OpenedDatabase[] = [];
const leases: RuntimeOwnership[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.close();
  for (const opened of dbs.splice(0)) await opened.close();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function open(): Promise<Database> {
  const opened = await openDatabase('pglite://:memory:');
  dbs.push(opened);
  return opened.db;
}

const user = (id: string): User => ({ id, username: `玩家${id.slice(0, 2)}` });

/** Fresh database with active release A and the given accounts. */
async function queueDb(...userIds: string[]) {
  const db = await open();
  await ensureDevelopmentRelease(db, A);
  for (const id of userIds) {
    await db.insert(accounts).values({
      id,
      username: user(id).username,
      username_key: id,
      password_hash: 'x',
      created_at: NOW,
    });
  }
  return db;
}

/** Stage, health-check and activate B over an active A (the admission barrier). */
async function switchToB(db: Database) {
  await db.insert(releaseVersions).values({
    id: B,
    state: 'staged',
    artifact_digest: 'digest-b',
    operation_id: 'op-b',
    created_at: NOW,
    updated_at: NOW,
  });
  await stageRelease(db, { operationId: 'op-b', releaseId: B, artifactDigest: 'digest-b' });
  const lease = await acquireRuntime(db, B);
  leases.push(lease);
  await checkRelease(db, { operationId: 'op-b', releaseId: B }, async (checked) => ({
    releaseId: checked,
    runtimeEpoch: lease.epoch,
  }));
  await activateRelease(db, { operationId: 'op-b', releaseId: B, expectedReleaseId: A });
}

async function ticketRow(db: Database, userId: string) {
  const [row] = await db.select().from(matchTickets).where(eq(matchTickets.user_id, userId));
  return row ?? null;
}

async function pair(db: Database, first: string, second: string) {
  await acquireMatch(db, A, user(first));
  const paired = await acquireMatch(db, A, user(second));
  if (!paired.roomId) throw new Error('配对没有产生房间');
  return { paired, roomId: paired.roomId };
}

describe('排队与配对', () => {
  it('首次排队进入等待；第二名玩家到来时一事务完成配对', async () => {
    const db = await queueDb('u1', 'u2');
    const started = Date.now();
    const waiting = await acquireMatch(db, A, user('u1'));
    expect(waiting).toMatchObject({ releaseId: A, state: 'waiting' });
    expect(waiting.expiresAt).toBeGreaterThan(started + QUEUE_TTL - 2_000);
    expect(waiting.expiresAt).toBeLessThanOrEqual(Date.now() + QUEUE_TTL);
    expect(await db.select().from(rooms)).toHaveLength(0);

    const paired = await acquireMatch(db, A, user('u2'));
    expect(paired.state).toBe('matched');
    expect(paired.roomId).toMatch(/^[0-9a-f]{24}$/);

    const mine = await acquireMatch(db, A, user('u1'));
    expect(mine).toMatchObject({ releaseId: A, state: 'matched', roomId: paired.roomId });

    const [room] = await db.select().from(rooms);
    expect(room).toMatchObject({
      mode: 'quick',
      phase: 'lobby',
      release_id: A,
      // The poll that completes the pairing hosts the room; the oldest waiter is the reserved seat.
      host_id: 'u2',
      reservation_state: 'reserved',
    });
    expect(room.reservation_expires_at).toBeGreaterThan(started);
    expect(room.reservation_expires_at).toBeLessThanOrEqual(Date.now() + RESERVATION_TTL);
    const seats = await db.select().from(players);
    expect(
      seats
        .sort((a, b) => a.user_id.localeCompare(b.user_id))
        .map((seat) => [seat.user_id, seat.slot]),
    ).toEqual([
      ['u1', 1],
      ['u2', 0],
    ]);
    const tickets = await db.select().from(matchTickets);
    expect(tickets).toHaveLength(2);
    for (const ticket of tickets) {
      expect(ticket).toMatchObject({ state: 'matched', room_id: paired.roomId });
    }
  });
  it('配对只在同版本的等待者之间发生', async () => {
    const db = await queueDb('u1', 'u2', 'u3');
    await db.insert(releaseVersions).values({
      id: B,
      state: 'staged',
      artifact_digest: 'digest-b',
      operation_id: 'op-b',
      created_at: NOW,
      updated_at: NOW,
    });
    await db.insert(matchTickets).values({
      user_id: 'u3',
      request_id: 'req-u3',
      release_id: B,
      username: '玩家u3',
      state: 'waiting',
      expires_at: Date.now() + QUEUE_TTL,
      created_at: NOW,
      updated_at: NOW,
    });

    const { paired } = await pair(db, 'u1', 'u2');
    expect(paired.state).toBe('matched');
    const stray = await ticketRow(db, 'u3');
    expect(stray).toMatchObject({ release_id: B, state: 'waiting', room_id: null });
  });

  it('轮询只刷新等待 TTL，请求标识与状态不变', async () => {
    const db = await queueDb('u1');
    await acquireMatch(db, A, user('u1'));
    const before = await ticketRow(db, 'u1');
    await db
      .update(matchTickets)
      .set({ expires_at: Date.now() + 5_000 })
      .where(eq(matchTickets.user_id, 'u1'));

    const polled = await acquireMatch(db, A, user('u1'));
    expect(polled.state).toBe('waiting');
    const after = await ticketRow(db, 'u1');
    expect(after.request_id).toBe(before.request_id);
    expect(after.expires_at).toBeGreaterThan(Date.now() + QUEUE_TTL - 2_000);
    expect(await db.select().from(rooms)).toHaveLength(0);
  });

  it('已匹配账户重复轮询返回同一房间，不新建房间', async () => {
    const db = await queueDb('u1', 'u2');
    const { roomId } = await pair(db, 'u1', 'u2');
    const again = await acquireMatch(db, A, user('u1'));
    expect(again).toMatchObject({ state: 'matched', roomId });
    expect(await db.select().from(rooms)).toHaveLength(1);
  });
});

describe('取消的真实性', () => {
  it('取消等待真实删除占位', async () => {
    const db = await queueDb('u1');
    await acquireMatch(db, A, user('u1'));
    const before = await ticketRow(db, 'u1');
    expect(await cancelMatch(db, 'u1')).toEqual({ cancelled: true, roomId: null });
    expect(await ticketRow(db, 'u1')).toBeNull();

    await acquireMatch(db, A, user('u1'));
    const recreated = await ticketRow(db, 'u1');
    expect(recreated.request_id).not.toBe(before.request_id);
    expect(recreated.state).toBe('waiting');
  });

  it('已开始的对局仍持有席位，取消如实返回 false', async () => {
    const db = await queueDb('u1', 'u2');
    await seedStartedRoom(db);
    expect(await cancelMatch(db, 'u1')).toMatchObject({ cancelled: false });
    expect(await ticketRow(db, 'u1')).toMatchObject({ state: 'matched' });
    expect(await ticketRow(db, 'u2')).toMatchObject({ state: 'matched' });
    expect((await db.select().from(rooms))[0].phase).toBe('playing');
  });

  it('弃赛玩家可以取消，其余座位与房间不受影响', async () => {
    const db = await queueDb('u1', 'u2');
    await seedStartedRoom(db);
    await db.insert(departures).values({
      room_id: ROOM,
      user_id: 'u1',
      match_id: 'm1',
      departed_at: NOW,
    });
    expect(await cancelMatch(db, 'u1')).toEqual({ cancelled: true, roomId: null });
    expect(await ticketRow(db, 'u1')).toBeNull();
    expect(await ticketRow(db, 'u2')).toMatchObject({ state: 'matched' });
    expect((await db.select().from(rooms))[0].phase).toBe('playing');
  });

  it('取消预约释放整组席位与双方票证，幸存者可直接重新排队', async () => {
    const db = await queueDb('u1', 'u2', 'u3');
    const { roomId } = await pair(db, 'u1', 'u2');
    expect(await cancelMatch(db, 'u1')).toEqual({ cancelled: true, roomId });
    expect(await ticketRow(db, 'u1')).toBeNull();
    expect(await ticketRow(db, 'u2')).toBeNull();

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room).toMatchObject({
      reservation_state: 'cancelled',
      reservation_expires_at: null,
      error: '匹配已取消，请重新匹配。',
    });
    expect(await db.select().from(players)).toHaveLength(0);

    const retry = await acquireMatch(db, A, user('u2'));
    expect(retry).toMatchObject({ state: 'waiting' });
    const repartnered = await acquireMatch(db, A, user('u3'));
    expect(repartnered).toMatchObject({ state: 'matched' });
    expect(repartnered.roomId).not.toBe(roomId);
  });

  it('过期的预约按超时取消', async () => {
    const db = await queueDb('u1', 'u2');
    const { roomId } = await pair(db, 'u1', 'u2');
    await db
      .update(rooms)
      .set({ reservation_expires_at: Date.now() - 1 })
      .where(eq(rooms.id, roomId));
    expect(await cancelMatch(db, 'u1')).toEqual({ cancelled: true, roomId });
    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room).toMatchObject({ reservation_state: 'expired', error: '匹配超时，请重新匹配。' });
    expect(await ticketRow(db, 'u2')).toBeNull();
  });

  it('取消与配对竞争不产生半途状态', async () => {
    const db = await queueDb('u1', 'u2');
    await acquireMatch(db, A, user('u1'));
    const [cancellation, pairing] = await Promise.all([
      cancelMatch(db, 'u1'),
      acquireMatch(db, A, user('u2')),
    ]);
    expect(cancellation.cancelled).toBe(true);
    expect(await ticketRow(db, 'u1')).toBeNull();
    const allRooms = await db.select().from(rooms);
    expect(allRooms.length).toBeLessThanOrEqual(1);
    for (const room of allRooms) {
      expect(['cancelled', 'expired']).toContain(room.reservation_state);
      expect(await db.select().from(players)).toHaveLength(0);
    }
    const survivor = await ticketRow(db, 'u2');
    if (pairing.state === 'matched') {
      expect(survivor?.room_id ?? null).toBe(pairing.roomId ?? null);
    }
  });
});

const ROOM = 'a1b2c3d4e5f6a7b8c9d0e1f2';

/** A started quick match: locked reservation, both seats seated, both tickets matched. */
async function seedStartedRoom(db: Database) {
  await db.insert(rooms).values({
    id: ROOM,
    release_id: A,
    host_id: 'u1',
    mode: 'quick',
    theme: '主题',
    difficulty: 'hard',
    phase: 'playing',
    match_id: 'm1',
    reservation_state: 'locked',
    created_at: NOW,
    updated_at: NOW,
  });
  for (const [userId, slot] of [
    ['u1', 0],
    ['u2', 1],
  ] as const) {
    await db.insert(players).values({
      room_id: ROOM,
      user_id: userId,
      username: user(userId).username,
      slot,
      joined_at: NOW,
      seated: 1,
    });
    await db.insert(matchTickets).values({
      user_id: userId,
      request_id: `req-${userId}`,
      release_id: A,
      username: user(userId).username,
      state: 'matched',
      room_id: ROOM,
      expires_at: NOW + RESERVATION_TTL,
      created_at: NOW,
      updated_at: NOW,
    });
  }
}

describe('版本切换后的准入与占用', () => {
  it('旧版本的等待被真实移除并拒绝；已发布的预约保留并可从新版本轮询到达', async () => {
    const db = await queueDb('u1', 'u2', 'u3', 'u4');
    const { paired, roomId } = await pair(db, 'u1', 'u2');
    await sleep(2);
    await acquireMatch(db, A, user('u3'));
    await switchToB(db);

    const u4 = await acquireMatch(db, A, user('u4')).catch((error) => error);
    expect(u4).toMatchObject({
      name: 'ReleaseError',
      code: 'release:update_required',
      status: 409,
      activeReleaseId: B,
    });
    expect(await ticketRow(db, 'u4')).toBeNull();

    const u3 = await acquireMatch(db, A, user('u3')).catch((error) => error);
    expect(u3).toMatchObject({ name: 'ReleaseError', code: 'release:update_required' });
    expect(await ticketRow(db, 'u3')).toBeNull();

    const preserved = await acquireMatch(db, A, user('u1'));
    expect(preserved).toMatchObject({
      releaseId: A,
      state: 'matched',
      roomId,
      expiresAt: paired.expiresAt,
    });
    const fromNewRelease = await acquireMatch(db, B, user('u1'));
    expect(fromNewRelease).toMatchObject({
      releaseId: A,
      state: 'matched',
      roomId,
      expiresAt: paired.expiresAt,
    });

    const newQueue = await acquireMatch(db, B, user('u4'));
    expect(newQueue).toMatchObject({ releaseId: B, state: 'waiting' });
    expect(await ticketRow(db, 'u4')).toMatchObject({ release_id: B, state: 'waiting' });
  });

  it('死掉的旧预约被释放后如实拒绝，新版本可重新排队', async () => {
    const db = await queueDb('u1', 'u2');
    const { roomId } = await pair(db, 'u1', 'u2');
    await sleep(1);
    await db
      .update(rooms)
      .set({ reservation_expires_at: Date.now() - 1 })
      .where(eq(rooms.id, roomId));
    await switchToB(db);

    const refused = await acquireMatch(db, A, user('u1')).catch((error) => error);
    expect(refused).toMatchObject({ code: 'release:update_required', activeReleaseId: B });
    expect(await ticketRow(db, 'u1')).toBeNull();

    const requeued = await acquireMatch(db, B, user('u1'));
    expect(requeued).toMatchObject({ releaseId: B, state: 'waiting' });
  });

  it('并发配对只产生一个房间，两张票指向同一房间', async () => {
    const db = await queueDb('u1', 'u2');
    const [first, second] = await Promise.all([
      acquireMatch(db, A, user('u1')),
      acquireMatch(db, A, user('u2')),
    ]);
    const allRooms = await db.select().from(rooms);
    expect(allRooms.length).toBeLessThanOrEqual(1);
    const created = allRooms[0];
    expect(created).toBeDefined();
    const roomId = created.id;
    expect([first.roomId, second.roomId]).toContain(roomId);
    const tickets = await db.select().from(matchTickets);
    expect(tickets).toHaveLength(2);
    for (const ticket of tickets) {
      expect(ticket).toMatchObject({ state: 'matched', room_id: roomId });
    }
  });

  it('同账户并发轮询收敛到同一张票，不产生重复占位', async () => {
    const db = await queueDb('u1');
    const [first, second] = await Promise.all([
      acquireMatch(db, A, user('u1')),
      acquireMatch(db, A, user('u1')),
    ]);
    const rows = await db.select().from(matchTickets);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('waiting');
    for (const ticket of [first, second]) {
      expect(ticket.state).toBe('waiting');
      expect(ticket.expiresAt).toBeGreaterThan(Date.now() + QUEUE_TTL - 5_000);
    }
  });

  it('匹配席位不会被后续轮询重置为等待', async () => {
    const db = await queueDb('u1', 'u2');
    const { roomId } = await pair(db, 'u1', 'u2');
    for (let count = 0; count < 3; count += 1) {
      const poll = await acquireMatch(db, A, user('u1'));
      expect(poll).toMatchObject({ state: 'matched', roomId });
    }
    const row = await ticketRow(db, 'u1');
    expect(row).toMatchObject({ state: 'matched', room_id: roomId });
    expect(await db.select().from(rooms)).toHaveLength(1);
  });

  it('对已退役版本的迟到轮询不会删除新版本的等待记录', async () => {
    const db = await queueDb('u1');
    await switchToB(db);
    const queued = await acquireMatch(db, B, user('u1'));
    expect(queued).toMatchObject({ releaseId: B, state: 'waiting' });

    const late = await acquireMatch(db, A, user('u1')).catch((error) => error);
    expect(late).toMatchObject({ code: 'release:update_required', activeReleaseId: B });
    const after = await ticketRow(db, 'u1');
    expect(after).toMatchObject({ release_id: B, state: 'waiting' });
  });

  it('新版本轮询将遗留的旧等待记录迁移到当前版本', async () => {
    const db = await queueDb('u1');
    await acquireMatch(db, A, user('u1'));
    await switchToB(db);

    const migrated = await acquireMatch(db, B, user('u1'));
    expect(migrated).toMatchObject({ releaseId: B, state: 'waiting' });
    const row = await ticketRow(db, 'u1');
    expect(row).toMatchObject({ release_id: B, state: 'waiting' });
    expect(await db.select().from(rooms)).toHaveLength(0);
  });
});
