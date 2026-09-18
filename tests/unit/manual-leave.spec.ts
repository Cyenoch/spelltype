/**
 * 手动离场 — the explicit-departure contract shared by the `leave` lobby frame and the
 * authenticated `POST /api/releases/:releaseId/rooms/:id/leave` endpoint.
 *
 * What is pinned here is the room's own decision, against real PGlite storage:
 * an explicit departure forfeits the live match (duel settles immediately,
 * larger tables fight on, results keep their order), ordinary membership releases
 * stay idempotent under HTTP retries, a settled match's ranking is never
 * rewritten by a later leave, and an abandoned match can neither be read nor
 * re-entered — while an ordinary disconnect never reaches this routine at all.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { Database, OpenedDatabase } from '../../server/db';
import { openDatabase } from '../../server/db';
import { ensureDevelopmentRelease } from '../../server/releases/control';
import { INITIAL_HEALTH } from '../../shared/protocol';
import type { Phase, ReservationState, User } from '../../shared/protocol';
import type { RoomSocket } from '../../server/contracts';
import { handleClientFrame } from '../../server/rooms/frames';
import { manualLeave } from '../../server/rooms/leave';
import { RoomRejection } from '../../server/rooms/rejection';
import { INPUT_MIN_MS_PER_CODE_POINT, INPUT_POLICY_VERSION } from '../../server/rooms/rules';
import { createRoomScope, SocketRegistry } from '../../server/rooms/scope';
import type { RoomScope, SocketAuth } from '../../server/rooms/scope';
import { snapshotFor } from '../../server/rooms/snapshots';
import { abandonedMatch, getDeparture } from '../../server/rooms/storage/departures';
import {
  getPlayer,
  insertPlayer,
  listPlayers,
  updatePlayer,
} from '../../server/rooms/storage/players';
import { getRoom, updateRoom } from '../../server/rooms/storage/room';
import { createRoom, readRoomRelease } from '../../server/rooms/storage/room';
import { advanceOnce } from '../../server/rooms/transitions';
import { results } from '../../server/db/schema';

const RELEASE_ID = 'a'.repeat(32);
const ROOM_ID = 'a'.repeat(24);
const NOW = 1_700_000_000_000;
const databases: OpenedDatabase[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});
const MATCH_ID = 'match-1';
/** Deadlines the room's own clock treats as due, and one far ahead of it. */
const PAST = Date.now() - 1;
const FUTURE = Date.now() + 100_000;

interface StubSocket {
  socket: RoomSocket;
  auth: SocketAuth;
  sent: unknown[];
  closed: { code: number; reason: string }[];
}

function stubSocket(userId: string): StubSocket {
  const state: StubSocket = {
    socket: null as unknown as RoomSocket,
    auth: {
      userId,
      username: userId,
      connId: `${userId}-conn`,
      sessionHash: `${userId}-session`,
      sessionExpires: Date.now() + 60_000,
      protocolVersion: 'spelltype.v2',
    },
    sent: [],
    closed: [],
  };
  let readyState = 1;
  state.socket = {
    get readyState() {
      return readyState;
    },
    send: (data: string) => {
      state.sent.push(JSON.parse(data));
    },
    close: (code: number, reason: string) => {
      state.closed.push({ code, reason });
      readyState = 3;
    },
  } as unknown as RoomSocket;
  return state;
}

/**
 * Locks the immutable per-match input policy on a live fixture and gives every seat an
 * already-satisfied spell eligibility, so forfeits and settlements can run under the gate.
 */
async function lockInputPolicy(db: Database, options: { openedAt: number }): Promise<void> {
  await updateRoom(db, ROOM_ID, {
    input_policy_version: INPUT_POLICY_VERSION,
    input_policy_mode: 'enforce',
    input_min_ms_per_code_point: INPUT_MIN_MS_PER_CODE_POINT,
  });
  for (const player of await listPlayers(db, ROOM_ID)) {
    await updatePlayer(db, ROOM_ID, player.user_id, {
      input_opened_at: options.openedAt,
      input_not_before: options.openedAt,
      draft_epoch: 0,
    });
  }
}

async function setup(
  userIds: readonly string[],
  room: {
    mode?: 'quick' | 'private';
    phase: Phase;
    reservationState?: ReservationState;
    reservationExpiresAt?: number | null;
    matchId?: string | null;
    deadline?: number;
    endReason?: 'elimination' | 'timeout' | null;
  },
): Promise<{ db: Database; scope: RoomScope; sockets: StubSocket[] }> {
  const opened = await openDatabase('pglite://:memory:');
  databases.push(opened);
  const { db } = opened;
  await ensureDevelopmentRelease(db, RELEASE_ID);
  await createRoom(db, {
    id: ROOM_ID,
    releaseId: RELEASE_ID,
    host: { id: userIds[0], username: userIds[0] },
    theme: '咒文契约',
    mode: room.mode ?? 'private',
    reserved: room.mode === 'quick' ? userIds.map((id) => ({ id, username: id })) : undefined,
  });
  await updateRoom(db, ROOM_ID, {
    phase: room.phase,
    locked: room.phase === 'lobby' ? 0 : 1,
    match_id: room.matchId ?? null,
    deadline: room.deadline ?? 0,
    end_reason: room.endReason ?? null,
  });
  const registry = new SocketRegistry();
  const sockets = userIds.map((userId) => {
    const stub = stubSocket(userId);
    registry.attach(stub.socket, stub.auth);
    return stub;
  });
  for (const userId of userIds) {
    await insertPlayer(db, ROOM_ID, { userId, username: userId, slotExpiresAt: null, now: NOW });
    await updatePlayer(db, ROOM_ID, userId, { seated: 1, conn_id: `${userId}-conn` });
  }
  const scope = createRoomScope({
    roomId: ROOM_ID,
    releaseId: RELEASE_ID,
    db,
    generate: async () => {
      throw new Error('generation not expected in this test');
    },
    registry,
    matchAdmission: 'open',
    inputPolicyMode: 'enforce',
  });
  // A live match under the new rules carries its locked policy; a settled or
  // pre-match room does not (rematch resets and re-locks it). Production code
  // never backfills a live match's missing policy, and neither do these fixtures.
  if (room.phase === 'generating' || room.phase === 'countdown' || room.phase === 'playing') {
    await lockInputPolicy(db, { openedAt: NOW - 1_000 });
  }
  return { db: db, scope, sockets };
}

async function allResults(
  db: Database,
): Promise<{ user_id: string; rank: number; hp_remaining: number }[]> {
  const rows = await db
    .select({ user_id: results.user_id, rank: results.rank, hp_remaining: results.hp_remaining })
    .from(results)
    .orderBy(results.user_id);
  return rows;
}

const user = (id: string): User => ({ id, username: id });

/** Asserts the call rejects with the room's own refusal class. */
async function rejectsWith(fn: () => Promise<unknown>, errorClass: unknown): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(errorClass);
    return;
  }
  throw new Error('expected the call to be refused');
}

describe('对局中离场', () => {
  it('双人局弃赛立即结算：对手获胜、双方成绩保留、离场者被永久拦下', async () => {
    const { db, scope } = await setup(['host', 'guest'], {
      phase: 'playing',
      matchId: MATCH_ID,
      reservationState: 'locked',
      deadline: FUTURE,
    });
    await updatePlayer(db, ROOM_ID, 'guest', { hp: 300, damage_dealt: 900 });
    await manualLeave(scope, 'guest');

    const room = await getRoom(db, ROOM_ID);
    expect(room!.phase).toBe('finished');
    expect(room!.end_reason).toBe('elimination');
    expect(room!.match_id).toBe(MATCH_ID);
    expect(room!.reservation_state).toBe('none');
    // 结果与终局同事务落库：可见状态直接是 saved。
    expect(room!.persistence).toBe('saved');

    const guest = await getPlayer(db, ROOM_ID, 'guest');
    expect(guest!.hp).toBe(0);
    expect(guest!.eliminated_at).not.toBeNull();
    expect((await getPlayer(db, ROOM_ID, 'host'))!.hp).toBe(INITIAL_HEALTH);
    expect(await abandonedMatch(db, ROOM_ID, 'guest', MATCH_ID)).toBe(true);

    const ranks = new Map((await allResults(db)).map((row) => [row.user_id, row.rank]));
    expect(ranks.get('host')).toBe(1);
    expect(ranks.get('guest')).toBe(2);

    await rejectsWith(() => snapshotFor(db, ROOM_ID, scope.registry, user('guest')), RoomRejection);
    const hostSnapshot = await snapshotFor(db, ROOM_ID, scope.registry, user('host'));
    expect(hostSnapshot.phase).toBe('finished');
    expect(hostSnapshot.players.find((player) => player.id === 'guest')?.rank).toBe(2);
  });

  it('WebSocket 的 leave 帧与 HTTP 离场共享同一次弃赛', async () => {
    const { db, scope, sockets } = await setup(['host', 'guest'], {
      phase: 'playing',
      matchId: MATCH_ID,
      deadline: FUTURE,
    });
    await handleClientFrame(scope, sockets[1].socket, sockets[1].auth, { type: 'leave' });
    expect((await getRoom(db, ROOM_ID))!.phase).toBe('finished');
    expect(await abandonedMatch(db, ROOM_ID, 'guest', MATCH_ID)).toBe(true);
    // 重放同一次离场是幂等成功，不再改写任何状态。
    await manualLeave(scope, 'guest');
    expect((await getRoom(db, ROOM_ID))!.end_reason).toBe('elimination');
  });

  it('多人局一人弃赛，其余人的对局照常继续', async () => {
    const { db, scope } = await setup(['host', 'guest', 'third'], {
      phase: 'playing',
      matchId: MATCH_ID,
      deadline: FUTURE,
    });
    await manualLeave(scope, 'guest');

    const room = await getRoom(db, ROOM_ID);
    expect(room!.phase).toBe('playing');
    expect(room!.end_reason).toBeNull();
    expect((await getPlayer(db, ROOM_ID, 'guest'))!.hp).toBe(0);
    expect((await getPlayer(db, ROOM_ID, 'third'))!.hp).toBe(INITIAL_HEALTH);
    expect(await allResults(db)).toEqual([]);
    expect(await abandonedMatch(db, ROOM_ID, 'guest', MATCH_ID)).toBe(true);
    expect(await abandonedMatch(db, ROOM_ID, 'third', MATCH_ID)).toBe(false);

    const hostSnapshot = await snapshotFor(db, ROOM_ID, scope.registry, user('host'));
    const guest = hostSnapshot.players.find((player) => player.id === 'guest')!;
    expect(guest.hp).toBe(0);
    expect(guest.eliminatedAt).not.toBeNull();
    expect(guest.connected).toBe(false);
  });

  it('已出局者的离场是幂等重放，不改写既有淘汰时间', async () => {
    const { db, scope } = await setup(['host', 'guest', 'third'], {
      phase: 'playing',
      matchId: MATCH_ID,
      deadline: FUTURE,
    });
    await updatePlayer(db, ROOM_ID, 'guest', { hp: 0, eliminated_at: NOW - 5_000 });
    await manualLeave(scope, 'guest');
    const first = await getPlayer(db, ROOM_ID, 'guest');
    await manualLeave(scope, 'guest');
    expect(await getPlayer(db, ROOM_ID, 'guest')).toMatchObject({
      hp: 0,
      eliminated_at: first!.eliminated_at,
    });
    expect((await getDeparture(db, ROOM_ID, 'guest'))!.match_id).toBe(MATCH_ID);
    expect((await getRoom(db, ROOM_ID))!.phase).toBe('playing');
  });
});

describe('开赛前离场', () => {
  it('生成期弃赛保留参与数据，出题后的续延也无法让弃赛者复活', async () => {
    const { db, scope } = await setup(['host', 'guest'], {
      phase: 'generating',
      matchId: MATCH_ID,
      reservationState: 'locked',
    });
    await manualLeave(scope, 'guest');
    expect((await getRoom(db, ROOM_ID))!.phase).toBe('generating');
    expect(await getPlayer(db, ROOM_ID, 'guest')).toMatchObject({ hp: 0, conn_id: null });
    expect(await abandonedMatch(db, ROOM_ID, 'guest', MATCH_ID)).toBe(true);

    // 出题完成进入倒计时，倒计时到点：战斗开始的一刻按存活规则结算。
    await updateRoom(db, ROOM_ID, {
      phase: 'countdown',
      deadline: PAST,
      spell_book: JSON.stringify([
        { name: '焰', text: 'Fire!', translation: '火焰！', element: 'fire' },
      ]),
    });
    await advanceOnce(scope);

    const room = await getRoom(db, ROOM_ID);
    expect(room!.phase).toBe('finished');
    expect(room!.end_reason).toBe('elimination');
    const ranks = new Map((await allResults(db)).map((row) => [row.user_id, row.rank]));
    expect(ranks.get('host')).toBe(1);
    expect(ranks.get('guest')).toBe(2);
    await rejectsWith(() => snapshotFor(db, ROOM_ID, scope.registry, user('guest')), RoomRejection);
  });

  it('快速预约期离场取消整个预约，重放与未离场的对方都被如实拒绝', async () => {
    const { db, scope, sockets } = await setup(['host', 'guest'], {
      mode: 'quick',
      phase: 'lobby',
      reservationState: 'reserved',
      reservationExpiresAt: FUTURE,
    });
    await manualLeave(scope, 'guest');

    const room = await getRoom(db, ROOM_ID);
    expect(room!.reservation_state).toBe('cancelled');
    expect(room!.reservation_expires_at).toBeNull();
    expect((await getRoom(db, ROOM_ID))!.error).toBe('对手已离开，请重新匹配。');
    // 预约收尾先广播理由，再清席位、关闭所有连接。
    expect(
      sockets.every((stub) =>
        stub.sent.some((message) => (message as { type: string }).type === 'state'),
      ),
    ).toBe(true);
    expect(sockets.map((stub) => stub.closed.at(-1)?.code)).toEqual([4001, 4001]);

    await manualLeave(scope, 'guest');
    await rejectsWith(() => manualLeave(scope, 'host'), RoomRejection);
  });

  it('开放大厅离场删除座位，离场标记让重放成功', async () => {
    const { db, scope } = await setup(['host', 'guest'], { phase: 'lobby' });
    await manualLeave(scope, 'guest');
    expect(await getPlayer(db, ROOM_ID, 'guest')).toBeNull();
    expect(await getPlayer(db, ROOM_ID, 'host')).not.toBeNull();
    expect(await getDeparture(db, ROOM_ID, 'guest')).toMatchObject({ match_id: null });
    await manualLeave(scope, 'guest');
    // 从未入座者不是幂等重放，而是诚实的 404。
    await rejectsWith(() => manualLeave(scope, 'stranger'), RoomRejection);
  });
});

describe('已结束的对局与匹配资格', () => {
  it('已结束对局的离场不改写任何名次与健康数据', async () => {
    const { db, scope } = await setup(['host', 'guest'], {
      phase: 'finished',
      matchId: MATCH_ID,
      deadline: 0,
      endReason: 'timeout',
    });
    await updatePlayer(db, ROOM_ID, 'host', { hp: 640, eliminated_at: PAST });
    await updatePlayer(db, ROOM_ID, 'guest', { hp: 300 });
    await manualLeave(scope, 'guest');

    expect((await getPlayer(db, ROOM_ID, 'host'))!.hp).toBe(640);
    expect(await getPlayer(db, ROOM_ID, 'guest')).toMatchObject({ hp: 300, eliminated_at: null });
    expect(await allResults(db)).toEqual([]);
    expect((await getDeparture(db, ROOM_ID, 'guest'))!.match_id).toBe(MATCH_ID);
    // 在场者读到的快照依旧带着完整名次。
    const hostSnapshot = await snapshotFor(db, ROOM_ID, scope.registry, user('host'));
    expect(hostSnapshot.phase).toBe('finished');
    expect(hostSnapshot.players.find((player) => player.id === 'guest')?.hp).toBe(300);
  });

  it('readRoomRelease 回传房间的发布归属与当前指针，供开局闸门判定', async () => {
    const { db } = await setup(['host', 'guest'], { phase: 'lobby' });
    expect(await readRoomRelease(db, ROOM_ID)).toMatchObject({
      state: 'active',
      activeReleaseId: RELEASE_ID,
      draining: false,
    });
  });
});
