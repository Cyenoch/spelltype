/**
 * 房间状态层单元测试 —— 基于真实 PGlite 的原生 Drizzle 存储层测试。
 *
 * 重点关注实现错误时会导致丢失、重复或泄露玩家数据的状态转换逻辑：
 * 房间创建、席位分配与过期、有界事件环、单局对决重置、幂等的结果写入以及按房间记录的离场条目。
 * 每个测试均通过生产环境使用的统一 `openDatabase` 入口创建各自独立的内存数据库。
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Database, OpenedDatabase } from '../../server/db';
import { openDatabase } from '../../server/db';
import { results } from '../../server/db/schema';
import { COMBAT_EVENT_RING_SIZE, INITIAL_HEALTH, type CombatEvent } from '../../shared/protocol';
import { appendEvents, readEvents } from '../../server/rooms/storage/events';
import { INPUT_POLICY_VERSION } from '../../server/rooms/rules';
import {
  abandonedMatch,
  getDeparture,
  recordDeparture,
} from '../../server/rooms/storage/departures';
import {
  armLobbySeatExpiry,
  countPlayers,
  deletePlayer,
  deleteReservedSeats,
  expireSeats,
  getPlayer,
  insertPlayer,
  listPlayers,
  resetPlayersForMatch,
  updatePlayer,
} from '../../server/rooms/storage/players';
import { insertResults } from '../../server/rooms/storage/results';
import { createRoom, getRoom, updateRoom } from '../../server/rooms/storage/room';

const ROOM_ID = 'a'.repeat(24);
const NOW = 1_700_000_000_000;
const databases: OpenedDatabase[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

/** 打开一个已执行数据库迁移的全新内存数据库。 */
async function openTestDb(): Promise<Database> {
  const opened = await openDatabase('pglite://:memory:');
  databases.push(opened);
  return opened.db;
}

async function createTestRoom(
  db: Database,
  init: Partial<{
    id: string;
    mode: 'private' | 'quick';
    theme: string;
    hostId: string;
    reserved: { id: string; username: string }[];
  }> = {},
): Promise<void> {
  await createRoom(db, {
    id: init.id ?? ROOM_ID,
    host: { id: init.hostId ?? 'host-1', username: init.hostId ?? 'host-1' },
    theme: init.theme ?? '咒文契约',
    mode: init.mode ?? 'private',
    reserved: init.reserved,
  });
}

/** 通过匹配器与 HTTP 层共享的接缝创建的大厅房间。 */
async function withRoom(): Promise<Database> {
  const db = await openTestDb();
  await createTestRoom(db);
  return db;
}

async function seat(
  db: Database,
  userId: string,
  slotExpiresAt: number | null = null,
): Promise<void> {
  const inserted = await insertPlayer(db, ROOM_ID, {
    userId,
    username: userId,
    slotExpiresAt,
    now: NOW,
  });
  if (inserted === null) throw new Error(`seat ${userId} refused`);
}

function event(seq: number): CombatEvent {
  return {
    seq,
    at: NOW + seq,
    attackerId: 'host-1',
    targetId: 'guest-1',
    element: 'fire',
    damage: 4,
    targetHp: 100,
    spellIndex: 0,
    eliminated: false,
  };
}

function resultRow(matchId: string) {
  return {
    match_id: matchId,
    user_id: 'host-1',
    room_id: ROOM_ID,
    theme: '咒文契约',
    damage_dealt: 100,
    hp_remaining: INITIAL_HEALTH,
    spells_cast: 1,
    correct_chars: 11,
    duration_ms: 30_000,
    rank: 1,
    cpm: 120,
    accuracy: 1,
    input_policy_version: INPUT_POLICY_VERSION,
    input_policy_mode: 'enforce' as const,
    input_gate_hits: 2,
    input_recoveries: 1,
    input_overloads: 0,
    input_recovered_completions: 1,
    input_recovery_departures: 0,
    input_min_completion_ratio: 0.25,
    created_at: NOW,
  };
}

describe('表结构', () => {
  it('重新打开同一数据库不丢弃已存在的房间与座位', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spelltype-room-store-'));
    try {
      const first = await openDatabase(`pglite://${dir}`);
      try {
        await createTestRoom(first.db);
      } finally {
        await first.close();
      }

      const second = await openDatabase(`pglite://${dir}`);
      const room = await getRoom(second.db, ROOM_ID);
      expect(room?.id).toBe(ROOM_ID);
      expect((await listPlayers(second.db, ROOM_ID)).map((player) => player.user_id)).toEqual([
        'host-1',
      ]);
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('建房', () => {
  it('创建房间写入主机与预留席位，重放同一房间是幂等成功', async () => {
    const db = await openTestDb();
    await createTestRoom(db, {
      mode: 'quick',
      reserved: [
        { id: 'host-1', username: 'host-1' },
        { id: 'guest-1', username: 'guest-1' },
      ],
    });
    const room = await getRoom(db, ROOM_ID);
    expect(room).toMatchObject({
      mode: 'quick',
      difficulty: 'hard',
      phase: 'lobby',
      reservation_state: 'reserved',
      locked: 0,
      persistence: 'idle',
    });
    expect(
      (await listPlayers(db, ROOM_ID)).map((player) => [player.user_id, player.seated]),
    ).toEqual([
      ['host-1', 0],
      ['guest-1', 0],
    ]);
    // 预约到期是房间里最早的 durable 闹钟。
    expect(room?.next_alarm_at).toBe(room?.reservation_expires_at);

    await createTestRoom(db, {
      mode: 'quick',
      reserved: [{ id: 'guest-1', username: 'guest-1' }],
    });
    expect((await listPlayers(db, ROOM_ID)).length).toBe(2);
  });
});

describe('座位', () => {
  it('按最小空位分配，满四人后拒绝第五人，空出的座位被复用', async () => {
    const db = await withRoom();
    for (const id of ['a', 'b', 'c']) await seat(db, id);
    expect((await listPlayers(db, ROOM_ID)).map((player) => player.slot)).toEqual([0, 1, 2, 3]);
    expect(
      await insertPlayer(db, ROOM_ID, {
        userId: 'e',
        username: 'e',
        slotExpiresAt: null,
        now: NOW,
      }),
    ).toBeNull();

    await deletePlayer(db, ROOM_ID, 'b');
    await seat(db, 'f');
    expect((await listPlayers(db, ROOM_ID)).map((player) => [player.user_id, player.slot])).toEqual(
      [
        ['host-1', 0],
        ['a', 1],
        ['f', 2],
        ['c', 3],
      ],
    );
  });

  it('只有从未真正连接的预留座位被释放', async () => {
    const db = await withRoom();
    await seat(db, 'a');
    await seat(db, 'b');
    await updatePlayer(db, ROOM_ID, 'b', { seated: 1 });
    await deleteReservedSeats(db, ROOM_ID);
    expect((await listPlayers(db, ROOM_ID)).map((player) => player.user_id)).toEqual(['b']);
  });

  it('回到大厅时只有未连接的座位被武装过期时间', async () => {
    const db = await withRoom();
    for (const id of ['a', 'b', 'c']) await seat(db, id);
    await armLobbySeatExpiry(db, ROOM_ID, ['b'], NOW + 5_000);
    expect((await getPlayer(db, ROOM_ID, 'b'))!.slot_expires_at).toBeNull();
    expect((await getPlayer(db, ROOM_ID, 'a'))!.slot_expires_at).toBe(NOW + 5_000);
    expect((await getPlayer(db, ROOM_ID, 'c'))!.slot_expires_at).toBe(NOW + 5_000);

    await armLobbySeatExpiry(db, ROOM_ID, [], NOW + 9_000);
    expect((await listPlayers(db, ROOM_ID)).map((player) => player.slot_expires_at)).toEqual([
      NOW + 9_000,
      NOW + 9_000,
      NOW + 9_000,
      NOW + 9_000,
    ]);
  });

  it('过期座位按时间释放，未设过期时间的座位保留', async () => {
    const db = await withRoom();
    await seat(db, 'expired', NOW - 1);
    await seat(db, 'later', NOW + 1_000);
    await seat(db, 'connected', null);
    expect(await expireSeats(db, ROOM_ID, NOW)).toBe(1);
    expect((await listPlayers(db, ROOM_ID)).map((player) => player.user_id)).toEqual([
      'host-1',
      'later',
      'connected',
    ]);
  });

  it('开新一局会把座位恢复为满血、第一篇与空草稿，并清空输入资格与本局摘要', async () => {
    const db = await withRoom();
    await seat(db, 'a');
    await updatePlayer(db, ROOM_ID, 'a', {
      progress: 7,
      spell_index: 3,
      spells_cast: 3,
      hp: 120,
      damage_dealt: 900,
      correct_chars: 88,
      attempt_total: 40,
      error_total: 5,
      cpm: 210,
      last_input: '霜月幽炎',
      eliminated_at: NOW,
      ready: 1,
      input_opened_at: NOW,
      input_not_before: NOW + 1_750,
      draft_epoch: 4,
      input_reset_reason: 'completion_too_early',
      input_sampled: 1,
      input_gate_hits: 3,
      input_recoveries: 2,
      input_min_completion_ratio: 0.5,
      input_overloads: 1,
      input_recovered_completions: 1,
      input_recovery_departures: 1,
    });
    await resetPlayersForMatch(db, ROOM_ID);
    expect(await getPlayer(db, ROOM_ID, 'a')).toMatchObject({
      progress: 0,
      spell_index: 0,
      spells_cast: 0,
      hp: INITIAL_HEALTH,
      max_hp: INITIAL_HEALTH,
      damage_dealt: 0,
      correct_chars: 0,
      attempt_total: 0,
      error_total: 0,
      cpm: 0,
      last_input: '',
      eliminated_at: null,
      ready: 1,
      input_opened_at: null,
      input_not_before: null,
      draft_epoch: 0,
      input_reset_reason: null,
      input_sampled: 0,
      input_gate_hits: 0,
      input_recoveries: 0,
      input_min_completion_ratio: null,
      input_overloads: 0,
      input_recovered_completions: 0,
      input_recovery_departures: 0,
    });
    expect(await countPlayers(db, ROOM_ID)).toBe(2);
  });
});

describe('列白名单', () => {
  it('固定列与未知字段都改不动，房间行与座位行都不会被注入', async () => {
    const db = await withRoom();
    await seat(db, 'a');
    await updateRoom(db, ROOM_ID, { id: 'hacked', created_at: 1, phase: 'playing' } as never);
    await updatePlayer(db, ROOM_ID, 'a', {
      user_id: 'hacked',
      username: 'hacked',
      hp: 5,
      not_a_column: 1,
    } as never);

    const room = await getRoom(db, ROOM_ID);
    expect(room!.id).toBe(ROOM_ID);
    expect(room!.created_at).toBeGreaterThan(0);
    expect(room!.phase).toBe('playing');
    const player = await getPlayer(db, ROOM_ID, 'a');
    expect(player!.user_id).toBe('a');
    expect(player!.username).toBe('a');
    expect(player!.hp).toBe(5);
    await updateRoom(db, ROOM_ID, { not_a_column: 'x' } as never);
    await updateRoom(db, ROOM_ID, { error: null });
  });
});

describe('事件环', () => {
  it('按容量截断，保留最新的伤害事件并推进最新序号', async () => {
    const db = await withRoom();
    for (let seq = 1; seq <= COMBAT_EVENT_RING_SIZE + 8; seq += 1)
      await appendEvents(db, ROOM_ID, [event(seq)]);
    const events = readEvents((await getRoom(db, ROOM_ID))!);
    expect(events).toHaveLength(COMBAT_EVENT_RING_SIZE);
    expect(events[0].seq).toBe(9);
    expect(events.at(-1)!.seq).toBe(COMBAT_EVENT_RING_SIZE + 8);
    expect((await getRoom(db, ROOM_ID))!.event_seq).toBe(COMBAT_EVENT_RING_SIZE + 8);
  });

  it('整批追加一次推进一个序号：快照永远看不到只有第一个目标落地的一批', async () => {
    const db = await withRoom();
    const batch = [event(1), event(2), event(3)];
    await appendEvents(db, ROOM_ID, batch);
    const events = readEvents((await getRoom(db, ROOM_ID))!);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect((await getRoom(db, ROOM_ID))!.event_seq).toBe(3);
    await appendEvents(db, ROOM_ID, []);
    expect(readEvents((await getRoom(db, ROOM_ID))!)).toHaveLength(3);
  });

  it('损坏或非数组的事件环读成空，而不是让房间读状态时崩掉', async () => {
    const db = await withRoom();
    await updateRoom(db, ROOM_ID, { events_json: '{oops' });
    expect(readEvents((await getRoom(db, ROOM_ID))!)).toEqual([]);
    await updateRoom(db, ROOM_ID, { events_json: '"咒文"' });
    expect(readEvents((await getRoom(db, ROOM_ID))!)).toEqual([]);
  });
});

describe('结果写入', () => {
  it('按 (match_id, user_id) 幂等：重放同一场的结算不会覆盖第一份成绩', async () => {
    const db = await withRoom();
    await insertResults(db, [{ ...resultRow('m2'), created_at: NOW + 2 }, resultRow('m1')]);
    await insertResults(db, [{ ...resultRow('m1'), damage_dealt: 999 }]);

    const rows = await db.select().from(results).orderBy(results.created_at);
    expect(rows.map((row) => row.match_id)).toEqual(['m1', 'm2']);
    expect(rows[0].damage_dealt).toBe(100);
    expect(rows.every((row) => row.room_id === ROOM_ID)).toBe(true);
  });
});

describe('离场记录', () => {
  it('按局判定弃赛：空局号与旧局号都不拦人，且一账户一房间只有一行', async () => {
    const db = await withRoom();
    // 开赛前的离场只是幂等标记，从不拦截重新加入。
    await recordDeparture(db, ROOM_ID, { userId: 'a', matchId: null, now: NOW });
    expect(await getDeparture(db, ROOM_ID, 'a')).toMatchObject({
      user_id: 'a',
      match_id: null,
      departed_at: NOW,
    });
    expect(await abandonedMatch(db, ROOM_ID, 'a', 'm1')).toBe(false);

    await recordDeparture(db, ROOM_ID, { userId: 'a', matchId: 'm1', now: NOW + 1 });
    expect(await abandonedMatch(db, ROOM_ID, 'a', 'm1')).toBe(true);
    expect(await abandonedMatch(db, ROOM_ID, 'a', 'm2')).toBe(false);
    expect(await abandonedMatch(db, ROOM_ID, 'a', null)).toBe(false);
    expect(await abandonedMatch(db, ROOM_ID, 'b', 'm1')).toBe(false);

    // 更晚一局的弃赛覆盖旧行：旧局号的记录随之失效。
    await recordDeparture(db, ROOM_ID, { userId: 'a', matchId: 'm2', now: NOW + 2 });
    expect(await abandonedMatch(db, ROOM_ID, 'a', 'm1')).toBe(false);
    expect(await getDeparture(db, ROOM_ID, 'a')).toMatchObject({
      match_id: 'm2',
      departed_at: NOW + 2,
    });
  });

  it('不同房间的离场记录互不影响', async () => {
    const db = await withRoom();
    const otherRoom = 'b'.repeat(24);
    await createTestRoom(db, { id: otherRoom, hostId: 'host-2', theme: '霜与火之歌' });
    await recordDeparture(db, ROOM_ID, { userId: 'a', matchId: 'm1', now: NOW });
    expect(await abandonedMatch(db, otherRoom, 'a', 'm1')).toBe(false);
    expect(await abandonedMatch(db, ROOM_ID, 'a', 'm1')).toBe(true);
  });
});
