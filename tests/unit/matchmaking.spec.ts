/**
 * 排队、配对与取消 —— 在单一全局运行时内针对真实 PGlite 存储的快速匹配队列。
 *
 * 此处锁定了匹配器自身可观察的契约：配对在单次事务中同时提交房间、席位和双方票据；
 * 轮询刷新等待记录的 TTL 而不改变其请求标识；取消具有真实性（已开始的对局保留席位）；
 * 释放的预约会解散整组并允许幸存者重新排队；并发轮询与取消/配对竞争能够收敛且不产生半途写入的状态；
 * 维护状态拒绝新条目而已配对的预约仍保持可读；丢失运行时围栏会作为真实错误抛出且零写入。
 * 合成对手兜底也独立锁定了契约：单独等待的玩家会等待真实对手，直到从入队算起的 10 秒截止时刻，
 * 随后匹配到一个不拥有账号、会话或票据的合成席位 —— 合格时优先重放幽灵，否则生成机器人 ——
 * 并且上述所有竞争和围栏规则对该路径同样成立。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { MaintenanceError } from '../../shared/maintenance';
import type { User } from '../../shared/protocol';
import { openDatabase, runtimeControl } from '../../server/db';
import type { Database, OpenedDatabase } from '../../server/db';
import { accounts, departures, ghosts, matchTickets, players, rooms } from '../../server/db/schema';
import { GHOST_RULES_VERSION } from '../../server/ghosts';
import { enterMaintenance } from '../../server/maintenance/control';
import {
  RuntimeOwnershipBusyError,
  RuntimeOwnershipLostError,
  acquireRuntime,
} from '../../server/maintenance/ownership';
import { acquireMatch, cancelMatch } from '../../server/matchmaking';

const NOW = 1_700_000_000_000;
const RESERVATION_TTL = 60_000;
const QUEUE_TTL = 60_000;

const dbs: OpenedDatabase[] = [];
const leases: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0)) await lease.close();
  for (const opened of dbs.splice(0)) await opened.close();
});

/** 非持有者调用方传递的显式围栏：匹配作为运行时的代理执行。 */
const fenced = async () => {};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function open(): Promise<Database> {
  const opened = await openDatabase('pglite://:memory:');
  dbs.push(opened);
  return opened.db;
}

const user = (id: string): User => ({ id, username: `玩家${id.slice(0, 2)}` });

/** 带有给定账号（每个账号一个微信身份）的新建数据库。 */
async function queueDb(...userIds: string[]) {
  const db = await open();
  for (const id of userIds) {
    await db.insert(accounts).values({
      id,
      username: user(id).username,
      wechat_identity: `union:${id}`,
      created_at: NOW,
    });
  }
  return db;
}

/** 控制行的当前修订号，即 enterMaintenance 所需的 CAS 参数。 */
async function controlRevision(db: Database): Promise<number> {
  const [row] = await db.select().from(runtimeControl);
  if (!row) throw new Error('runtime_control has no singleton row');
  return row.revision;
}

async function ticketRow(db: Database, userId: string) {
  const [row] = await db.select().from(matchTickets).where(eq(matchTickets.user_id, userId));
  return row ?? null;
}

async function pair(db: Database, first: string, second: string) {
  await acquireMatch(db, user(first), fenced);
  const paired = await acquireMatch(db, user(second), fenced);
  if (!paired.roomId) throw new Error('配对没有产生房间');
  return { paired, roomId: paired.roomId };
}

/** 一份源自既有账号、在当前规则下合格的已发布幽灵录像。 */
async function seedGhost(db: Database, ghostId: string, sourceUserId: string) {
  await db.insert(accounts).values({
    id: sourceUserId,
    username: user(sourceUserId).username,
    wechat_identity: `union:${sourceUserId}`,
    created_at: NOW,
  });
  await db.insert(ghosts).values({
    id: ghostId,
    source_user_id: sourceUserId,
    theme: '幽灵主题',
    book: [{ name: 'Ember', text: 'AB', translation: '余烬', element: 'fire' }],
    casts: [{ at: 0, spellIndex: 0 }],
    rules_version: GHOST_RULES_VERSION,
    created_at: NOW,
  });
}

/** 将等待条目的到达时间提前，从而无需真实休眠即可测试幽灵截止时间。 */
async function ageWait(db: Database, userId: string, waitedMs: number) {
  await db
    .update(matchTickets)
    .set({ created_at: Date.now() - waitedMs })
    .where(eq(matchTickets.user_id, userId));
}

/** 推动一个账号越过兜底截止时间进入合成房间；返回轮询响应。 */
async function ghostMatch(db: Database, userId: string) {
  await acquireMatch(db, user(userId), fenced);
  await ageWait(db, userId, 30_000);
  const matched = await acquireMatch(db, user(userId), fenced);
  if (matched.state !== 'matched' || !matched.roomId) throw new Error('合成对手兜底没有产生房间');
  return { matched, roomId: matched.roomId };
}

describe('排队与配对', () => {
  it('首次排队进入等待；第二名玩家到来时一事务完成配对', async () => {
    const db = await queueDb('u1', 'u2');
    const started = Date.now();
    const waiting = await acquireMatch(db, user('u1'), fenced);
    expect(waiting).toMatchObject({ state: 'waiting' });
    expect(waiting.expiresAt).toBeGreaterThan(started + QUEUE_TTL - 2_000);
    expect(waiting.expiresAt).toBeLessThanOrEqual(Date.now() + QUEUE_TTL);
    expect(await db.select().from(rooms)).toHaveLength(0);

    const paired = await acquireMatch(db, user('u2'), fenced);
    expect(paired.state).toBe('matched');
    expect(paired.roomId).toMatch(/^[0-9a-f]{24}$/);

    const mine = await acquireMatch(db, user('u1'), fenced);
    expect(mine).toMatchObject({ state: 'matched', roomId: paired.roomId });

    const [room] = await db.select().from(rooms);
    expect(room).toMatchObject({
      mode: 'quick',
      phase: 'lobby',
      // 完成配对的轮询作为房间房主；等待时间最长的玩家作为预留席位。
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

  it('轮询只刷新等待 TTL，请求标识与状态不变', async () => {
    const db = await queueDb('u1');
    await acquireMatch(db, user('u1'), fenced);
    const before = await ticketRow(db, 'u1');
    await db
      .update(matchTickets)
      .set({ expires_at: Date.now() + 5_000 })
      .where(eq(matchTickets.user_id, 'u1'));

    const polled = await acquireMatch(db, user('u1'), fenced);
    expect(polled.state).toBe('waiting');
    const after = await ticketRow(db, 'u1');
    expect(after.request_id).toBe(before.request_id);
    expect(after.expires_at).toBeGreaterThan(Date.now() + QUEUE_TTL - 2_000);
    expect(await db.select().from(rooms)).toHaveLength(0);
  });

  it('已匹配账户重复轮询返回同一房间，不新建房间', async () => {
    const db = await queueDb('u1', 'u2');
    const { roomId } = await pair(db, 'u1', 'u2');
    const again = await acquireMatch(db, user('u1'), fenced);
    expect(again).toMatchObject({ state: 'matched', roomId });
    expect(await db.select().from(rooms)).toHaveLength(1);
  });

  it('并发配对只产生一个房间，两张票指向同一房间', async () => {
    const db = await queueDb('u1', 'u2');
    const [first, second] = await Promise.all([
      acquireMatch(db, user('u1'), fenced),
      acquireMatch(db, user('u2'), fenced),
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
      acquireMatch(db, user('u1'), fenced),
      acquireMatch(db, user('u1'), fenced),
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
      const poll = await acquireMatch(db, user('u1'), fenced);
      expect(poll).toMatchObject({ state: 'matched', roomId });
    }
    const row = await ticketRow(db, 'u1');
    expect(row).toMatchObject({ state: 'matched', room_id: roomId });
    expect(await db.select().from(rooms)).toHaveLength(1);
  });
});

describe('取消的真实性', () => {
  it('取消等待真实删除占位；重新排队拿到全新请求标识', async () => {
    const db = await queueDb('u1');
    await acquireMatch(db, user('u1'), fenced);
    const before = await ticketRow(db, 'u1');
    expect(await cancelMatch(db, 'u1', fenced)).toEqual({ cancelled: true, roomId: null });
    expect(await ticketRow(db, 'u1')).toBeNull();

    await acquireMatch(db, user('u1'), fenced);
    const recreated = await ticketRow(db, 'u1');
    expect(recreated.request_id).not.toBe(before.request_id);
    expect(recreated.state).toBe('waiting');
  });

  it('已开始的对局仍持有席位，取消如实返回 false', async () => {
    const db = await queueDb('u1', 'u2');
    await seedStartedRoom(db);
    expect(await cancelMatch(db, 'u1', fenced)).toMatchObject({ cancelled: false });
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
    expect(await cancelMatch(db, 'u1', fenced)).toEqual({ cancelled: true, roomId: null });
    expect(await ticketRow(db, 'u1')).toBeNull();
    expect(await ticketRow(db, 'u2')).toMatchObject({ state: 'matched' });
    expect((await db.select().from(rooms))[0].phase).toBe('playing');
  });

  it('取消预约释放整组席位与双方票证，幸存者可直接重新排队', async () => {
    const db = await queueDb('u1', 'u2', 'u3');
    const { roomId } = await pair(db, 'u1', 'u2');
    expect(await cancelMatch(db, 'u1', fenced)).toEqual({ cancelled: true, roomId });
    expect(await ticketRow(db, 'u1')).toBeNull();
    expect(await ticketRow(db, 'u2')).toBeNull();

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room).toMatchObject({
      reservation_state: 'cancelled',
      reservation_expires_at: null,
      error: '匹配已取消，请重新匹配。',
    });
    expect(await db.select().from(players)).toHaveLength(0);

    const retry = await acquireMatch(db, user('u2'), fenced);
    expect(retry).toMatchObject({ state: 'waiting' });
    const repartnered = await acquireMatch(db, user('u3'), fenced);
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
    expect(await cancelMatch(db, 'u1', fenced)).toEqual({ cancelled: true, roomId });
    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room).toMatchObject({ reservation_state: 'expired', error: '匹配超时，请重新匹配。' });
    expect(await ticketRow(db, 'u2')).toBeNull();
  });

  it('取消与配对竞争不产生半途状态', async () => {
    const db = await queueDb('u1', 'u2');
    await acquireMatch(db, user('u1'), fenced);
    const [cancellation, pairing] = await Promise.all([
      cancelMatch(db, 'u1', fenced),
      acquireMatch(db, user('u2'), fenced),
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

describe('合成对手兜底', () => {
  it('等待不足时限不分配对手；到点后的下一次轮询完成分配', async () => {
    const db = await queueDb('u1');
    await seedGhost(db, 'g1', 'u2');
    await acquireMatch(db, user('u1'), fenced);

    // 等待 9 秒：真实对手仍可能出现，因此轮询仅返回等待中。
    await ageWait(db, 'u1', 9_000);
    expect(await acquireMatch(db, user('u1'), fenced)).toMatchObject({ state: 'waiting' });
    expect(await db.select().from(rooms)).toHaveLength(0);

    await ageWait(db, 'u1', 10_000);
    const matched = await acquireMatch(db, user('u1'), fenced);
    expect(matched).toMatchObject({ state: 'matched' });
    expect(await db.select().from(rooms)).toHaveLength(1);
  });

  it('幽灵对局一次事务成形：合成席位就座就绪，无账号无多余票', async () => {
    const db = await queueDb('u1');
    await seedGhost(db, 'g1', 'u2');
    const started = Date.now();
    const { roomId, matched } = await ghostMatch(db, 'u1');

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room).toMatchObject({
      mode: 'quick',
      phase: 'lobby',
      host_id: 'u1',
      reservation_state: 'reserved',
      opponent_kind: 'ghost',
      ghost_id: 'g1',
      theme: '幽灵主题',
    });
    expect(room.reservation_expires_at).toBeGreaterThan(started);

    const seats = await db.select().from(players).where(eq(players.room_id, roomId));
    expect(seats.sort((a, b) => a.slot - b.slot)).toMatchObject([
      { user_id: 'u1', slot: 0, seated: 0, ready: 0, conn_id: null },
      {
        user_id: `synthetic:${roomId}`,
        username: 'Ghost / 训练法师',
        slot: 1,
        seated: 1,
        ready: 1,
        conn_id: null,
        slot_expires_at: null,
      },
    ]);

    // 仅消耗人类玩家的票据；合成席位既无账号也无票据。
    expect(await db.select().from(matchTickets)).toMatchObject([
      { user_id: 'u1', state: 'matched', room_id: roomId },
    ]);
    expect(
      await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, `synthetic:${roomId}`)),
    ).toEqual([]);
    expect(matched).toMatchObject({ state: 'matched', roomId });
  });

  it('真实等待者优先于幽灵兜底', async () => {
    const db = await queueDb('u1', 'u2');
    await seedGhost(db, 'g1', 'u3');
    await acquireMatch(db, user('u1'), fenced);
    await ageWait(db, 'u1', 30_000);

    const paired = await acquireMatch(db, user('u2'), fenced);
    expect(paired).toMatchObject({ state: 'matched' });
    const allRooms = await db.select().from(rooms);
    expect(allRooms).toHaveLength(1);
    expect(allRooms[0]).toMatchObject({ opponent_kind: 'human', ghost_id: null });
    const tickets = await db.select().from(matchTickets);
    expect(tickets).toHaveLength(2);
    for (const ticket of tickets) {
      expect(ticket).toMatchObject({ state: 'matched', room_id: paired.roomId });
    }
  });

  it('没有合格幽灵时兜底为机器人对局', async () => {
    const db = await queueDb('u1');
    await seedGhost(db, 'g1', 'u2');
    // 在过时规则下记录的幽灵绝不合格，因此合成对手为机器人。
    await db.update(ghosts).set({ rules_version: 'stale' }).where(eq(ghosts.id, 'g1'));
    const { roomId } = await ghostMatch(db, 'u1');

    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room).toMatchObject({ opponent_kind: 'bot', ghost_id: null });
    const seats = await db.select().from(players).where(eq(players.room_id, roomId));
    expect(seats).toHaveLength(2);
    expect(seats.find((seat) => seat.slot === 1)).toMatchObject({
      user_id: `synthetic:${roomId}`,
      username: 'Ghost / 训练法师',
      seated: 1,
      ready: 1,
      slot_expires_at: null,
    });
    expect(await db.select().from(matchTickets)).toMatchObject([
      { user_id: 'u1', state: 'matched', room_id: roomId },
    ]);
  });

  it('重复轮询不重置等待时长，过期重入不继承旧等待', async () => {
    const db = await queueDb('u1');
    await seedGhost(db, 'g1', 'u2');
    await acquireMatch(db, user('u1'), fenced);

    // 刷新保留到达时间：等待 5 秒仍算等待 5 秒。
    await ageWait(db, 'u1', 5_000);
    const before = await ticketRow(db, 'u1');
    await acquireMatch(db, user('u1'), fenced);
    await acquireMatch(db, user('u1'), fenced);
    const after = await ticketRow(db, 'u1');
    expect(after?.created_at).toBe(before?.created_at);
    expect(await db.select().from(rooms)).toHaveLength(0);

    // 失效条目已离开队列：重新进入视为全新请求，不继承旧的等待时间。
    await db
      .update(matchTickets)
      .set({ created_at: Date.now() - 30_000, expires_at: Date.now() - 1 })
      .where(eq(matchTickets.user_id, 'u1'));
    expect(await acquireMatch(db, user('u1'), fenced)).toMatchObject({ state: 'waiting' });
    const revived = await ticketRow(db, 'u1');
    expect(revived?.created_at).toBeGreaterThan(Date.now() - 5_000);
    expect(await db.select().from(rooms)).toHaveLength(0);

    // 全新到达的请求如期触发幽灵截止时间。
    await ageWait(db, 'u1', 10_000);
    expect((await acquireMatch(db, user('u1'), fenced)).state).toBe('matched');
  });

  it('幽灵对局后重复轮询返回同一房间，账户仍只占一个座位', async () => {
    const db = await queueDb('u1');
    await seedGhost(db, 'g1', 'u2');
    const { roomId } = await ghostMatch(db, 'u1');
    for (let count = 0; count < 3; count += 1) {
      expect(await acquireMatch(db, user('u1'), fenced)).toMatchObject({
        state: 'matched',
        roomId,
      });
    }
    expect(await db.select().from(rooms)).toHaveLength(1);
    expect(await db.select().from(matchTickets)).toHaveLength(1);
    expect(await db.select().from(players)).toHaveLength(2);
  });

  it('并发轮询到点只产生一个幽灵房间，两个回答指向它', async () => {
    const db = await queueDb('u1');
    await seedGhost(db, 'g1', 'u2');
    await acquireMatch(db, user('u1'), fenced);
    await ageWait(db, 'u1', 30_000);
    const [first, second] = await Promise.all([
      acquireMatch(db, user('u1'), fenced),
      acquireMatch(db, user('u1'), fenced),
    ]);
    expect(first.state).toBe('matched');
    expect(second.state).toBe('matched');
    expect(first.roomId).toBe(second.roomId);
    expect(await db.select().from(rooms)).toHaveLength(1);
    expect(await db.select().from(matchTickets)).toHaveLength(1);
  });

  it('取消幽灵对局释放合成席位，账户可立即重新排队', async () => {
    const db = await queueDb('u1');
    await seedGhost(db, 'g1', 'u2');
    const { roomId } = await ghostMatch(db, 'u1');

    expect(await cancelMatch(db, 'u1', fenced)).toEqual({ cancelled: true, roomId });
    expect(await ticketRow(db, 'u1')).toBeNull();
    expect(await db.select().from(players)).toHaveLength(0);
    const [room] = await db.select().from(rooms).where(eq(rooms.id, roomId));
    expect(room).toMatchObject({
      reservation_state: 'cancelled',
      reservation_expires_at: null,
      error: '匹配已取消，请重新匹配。',
    });

    expect(await acquireMatch(db, user('u1'), fenced)).toMatchObject({ state: 'waiting' });
  });

  it('取消与幽灵分配竞争不产生半途房间', async () => {
    const db = await queueDb('u1');
    await seedGhost(db, 'g1', 'u2');
    await acquireMatch(db, user('u1'), fenced);
    await ageWait(db, 'u1', 30_000);
    const [cancellation, matching] = await Promise.all([
      cancelMatch(db, 'u1', fenced),
      acquireMatch(db, user('u1'), fenced),
    ]);
    expect(cancellation.cancelled).toBe(true);
    const allRooms = await db.select().from(rooms);
    expect(allRooms.length).toBeLessThanOrEqual(1);
    for (const room of allRooms) {
      expect(room.reservation_state).toBe('cancelled');
      expect(await db.select().from(players)).toHaveLength(0);
    }
    const ticket = await ticketRow(db, 'u1');
    if (matching.state === 'matched') {
      // 分配抢先：因此取消操作销毁了房间并释放了票据。
      expect(ticket).toBeNull();
      expect(allRooms).toHaveLength(1);
      expect(matching.roomId).toBe(allRooms[0].id);
    } else {
      // 取消抢先：轮询要么全新重新排队，要么根据随后被作废的快照响应等待中 —— 无论如何旧的等待都随房间一同消失。
      expect(ticket === null || ticket.created_at > Date.now() - 5_000).toBe(true);
      expect(allRooms).toHaveLength(0);
    }
  });

  it('排空取消等待票据，超时请求不能创建合成对手或重新排队', async () => {
    const db = await queueDb('u1');
    await seedGhost(db, 'g1', 'u2');
    await acquireMatch(db, user('u1'), fenced);
    await ageWait(db, 'u1', 30_000);
    await enterMaintenance(db, await controlRevision(db));

    const refused = await acquireMatch(db, user('u1'), fenced).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(MaintenanceError);
    expect(await db.select().from(rooms)).toHaveLength(0);
    const ticket = await ticketRow(db, 'u1');
    expect(ticket).toBeNull();
  });
});

describe('维护准入', () => {
  it('排空中新排队被拒绝并保持无占位，已匹配的预约仍可读', async () => {
    const db = await queueDb('u1', 'u2', 'u3');
    const { paired, roomId } = await pair(db, 'u1', 'u2');
    await sleep(2);
    await acquireMatch(db, user('u3'), fenced);

    // 进入维护走真实 CAS：等待条目被真实删除，而不是静默过期。
    await enterMaintenance(db, await controlRevision(db));

    // 新排队被拒绝，且不留下任何占位。
    const refused = await acquireMatch(db, user('u3'), fenced).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(MaintenanceError);
    expect(refused).toMatchObject({ code: 'maintenance:draining', status: 503 });
    expect(await ticketRow(db, 'u3')).toBeNull();

    // 已匹配的预约保持可读：同一房间、同一到期时刻，绝不被维护改写。
    const preserved = await acquireMatch(db, user('u1'), fenced);
    expect(preserved).toMatchObject({
      state: 'matched',
      roomId,
      expiresAt: paired.expiresAt,
    });
  });

  it('丢失运行时围栏的排队原样报错，零写入', async () => {
    const db = await queueDb('u1', 'u2');
    const fence = async (): Promise<void> => {
      throw new RuntimeOwnershipLostError(1);
    };
    const refused = await acquireMatch(db, user('u1'), fence).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RuntimeOwnershipLostError);
    expect(await db.select().from(matchTickets)).toEqual([]);
    expect(await db.select().from(rooms)).toEqual([]);

    const cancelled = await cancelMatch(db, 'u1', fence).catch((error: unknown) => error);
    expect(cancelled).toBeInstanceOf(RuntimeOwnershipLostError);
  });

  it('全局只有一个运行时租约：租约未过期时后来者被拒，过期后接任且旧证明失效', async () => {
    const db = await queueDb('u1');
    const first = await acquireRuntime(db);
    leases.push(first);

    // 活租约在手：第二个运行时不得静默接管，只能得到 busy。
    const busy = await acquireRuntime(db).catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(RuntimeOwnershipBusyError);

    // 租约到期：过期租约永不复活——接任者拿到更大的代次。
    await db.update(runtimeControl).set({ lease_until: 0 }).where(eq(runtimeControl.singleton, 1));
    const successor = await acquireRuntime(db);
    leases.push(successor);
    expect(successor.epoch).toBeGreaterThan(first.epoch);

    await rejects(
      db.transaction((tx) => first.assert(tx)),
      RuntimeOwnershipLostError,
    );
    const ticket = await acquireMatch(db, { id: 'u1', username: 'u1' }, (tx) =>
      successor.assert(tx),
    );
    expect(ticket.state).toBe('waiting');
  });
});

const ROOM = 'a1b2c3d4e5f6a7b8c9d0e1f2';

/** 已开始的快速对局：锁定的预约、双席位已就座、双方票据已匹配。 */
async function seedStartedRoom(db: Database) {
  await db.insert(rooms).values({
    id: ROOM,
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
      username: user(userId).username,
      state: 'matched',
      room_id: ROOM,
      expires_at: NOW + RESERVATION_TTL,
      created_at: NOW,
      updated_at: NOW,
    });
  }
}
