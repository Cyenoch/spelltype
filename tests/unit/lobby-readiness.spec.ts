/**
 * 大厅准备状态与开局闸门 — readiness sync during generation, and the durable admission rules
 * every new match passes through.
 *
 * Readiness changes stay visible to both seats while the match is being generated, and are
 * refused once the match has a clock. Draining is durable maintenance state in the shared
 * control row: it refuses new matches without touching live ones, their rosters or a finished
 * match's rematch reset. Only the transport is substituted; frames, state changes and snapshots
 * run the real domain code over real PGlite.
 */
import { afterEach, expect, it } from 'bun:test';
import type { OpenedDatabase } from '../../server/db';
import { openDatabase, runtimeControl } from '../../server/db';
import { enterMaintenance } from '../../server/maintenance/control';
import { WS_PROTOCOL, type InputPolicyMode, type ServerMessage } from '../../shared/protocol';
import type { RoomSocket, RoomSocketData } from '../../server/contracts';
import { handleClientFrame } from '../../server/rooms/frames';
import { startMatchTx, maybeAutoStartTx } from '../../server/rooms/match';
import { INPUT_MIN_MS_PER_CODE_POINT, INPUT_POLICY_VERSION } from '../../server/rooms/rules';
import { SocketRegistry } from '../../server/rooms/scope';
import type { RoomScope, SocketAuth } from '../../server/rooms/scope';
import { createRoomScope } from '../../server/rooms/scope';
import { snapshotFor } from '../../server/rooms/snapshots';
import {
  getPlayer,
  insertPlayer,
  listPlayers,
  updatePlayer,
} from '../../server/rooms/storage/players';
import { createRoom, getRoom, updateRoom } from '../../server/rooms/storage/room';
import { advanceOnce } from '../../server/rooms/transitions';

const ROOM_ID = 'a'.repeat(24);
const INVALID_POLICY_MODE = 'normal' as InputPolicyMode;

const databases: OpenedDatabase[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
});

function stubSocket(auth: SocketAuth): { socket: RoomSocket; received: ServerMessage[] } {
  const received: ServerMessage[] = [];
  let readyState = 1;
  const socket = {
    get readyState() {
      return readyState;
    },
    send: (data: string) => {
      received.push(JSON.parse(data) as ServerMessage);
    },
    close: () => {
      readyState = 3;
    },
    data: {
      roomId: ROOM_ID,
      protocolVersion: WS_PROTOCOL,
      session: {
        user: { id: auth.userId, username: auth.username },
        role: 'user',
        tokenHash: auth.sessionHash,
        expiresAt: auth.sessionExpires,
      },
    } satisfies RoomSocketData,
  } as unknown as RoomSocket;
  return { socket, received };
}

/** Fresh in-memory database with migrations applied. */
async function openSeededDb(): Promise<OpenedDatabase> {
  const opened = await openDatabase('pglite://:memory:');
  databases.push(opened);
  return opened;
}

/** Flips the shared control row to draining through the real revision-CAS entry. */
async function enterDraining(db: OpenedDatabase['db']): Promise<void> {
  const [control] = await db.select().from(runtimeControl);
  if (!control) throw new Error('runtime_control has no singleton row');
  await enterMaintenance(db, control.revision);
}

it('生成咒文期间准备与取消准备会同步给双方，倒计时开始后拒绝变更', async () => {
  const opened = await openSeededDb();
  const db = opened.db;
  const now = Date.now();
  await createRoom(db, {
    id: ROOM_ID,
    host: { id: 'host', username: 'host' },
    theme: '咒文契约',
    mode: 'quick',
    reserved: [
      { id: 'host', username: 'host' },
      { id: 'guest', username: 'guest' },
    ],
  });
  const identities: SocketAuth[] = ['host', 'guest'].map((userId) => ({
    userId,
    username: userId,
    connId: `${userId}-connection`,
    sessionHash: `${userId}-session`,
    sessionExpires: now + 60_000,
    protocolVersion: WS_PROTOCOL,
  }));
  const registry = new SocketRegistry();
  const stubs = identities.map((identity) => {
    const stub = stubSocket(identity);
    registry.attach(stub.socket, identity);
    return stub;
  });
  const scope: RoomScope = createRoomScope({
    roomId: ROOM_ID,
    db,
    generate: async () => {
      throw new Error('generation not expected in this test');
    },
    registry,
    inputPolicyMode: 'enforce',
  });
  for (const identity of identities) {
    await insertPlayer(db, ROOM_ID, {
      userId: identity.userId,
      username: identity.username,
      slotExpiresAt: null,
      now,
    });
    await updatePlayer(db, ROOM_ID, identity.userId, {
      seated: 1,
      conn_id: identity.connId,
    });
  }
  await updateRoom(db, ROOM_ID, { phase: 'generating', locked: 1 });
  for (const ready of [true, false]) {
    await handleClientFrame(scope, stubs[1].socket, identities[1], { type: 'ready', ready });
    expect(stubs[1].received.at(-1)?.type).toBe('state');
    for (const stub of stubs) {
      const message = stub.received.at(-1);
      expect(message?.type).toBe('state');
      if (message?.type !== 'state') throw new Error('Expected a room snapshot');
      expect(message.room.phase).toBe('generating');
      expect(message.room.startedAt).toBeNull();
      expect(message.room.players.find((player) => player.id === 'guest')?.ready).toBe(ready);
    }
  }
  for (const phase of ['countdown', 'playing'] as const) {
    await updateRoom(db, ROOM_ID, { phase });
    await handleClientFrame(scope, stubs[1].socket, identities[1], { type: 'ready', ready: true });
    expect(stubs[1].received.at(-1)?.type).toBe('error');
  }
  // 拒绝之后座位上的准备状态保持拒绝前的原样。
  const guest = (
    await snapshotFor(db, ROOM_ID, registry, { id: 'guest', username: 'guest' })
  ).players.find((player) => player.id === 'guest');
  expect(guest?.ready).toBe(false);
  expect(await getRoom(db, ROOM_ID)).toMatchObject({ phase: 'playing' });
});

it.each(['private', 'quick'] as const)('维护期间不锁定 %s 房间或重置已有座位', async (mode) => {
  const opened = await openSeededDb();
  const db = opened.db;
  const now = Date.now();
  const roomId = mode === 'quick' ? 'b'.repeat(24) : 'c'.repeat(24);
  await createRoom(db, {
    id: roomId,
    host: { id: 'host', username: 'host' },
    theme: '维护',
    mode,
    reserved:
      mode === 'quick'
        ? [
            { id: 'host', username: 'host' },
            { id: 'guest', username: 'guest' },
          ]
        : undefined,
  });
  const registry = new SocketRegistry();
  for (const userId of ['host', 'guest']) {
    const identity: SocketAuth = {
      userId,
      username: userId,
      connId: `${userId}-conn`,
      sessionHash: `${userId}-session`,
      sessionExpires: now + 60_000,
      protocolVersion: WS_PROTOCOL,
    };
    registry.attach(stubSocket(identity).socket, identity);
    await insertPlayer(db, roomId, { userId, username: userId, slotExpiresAt: null, now });
    await updatePlayer(db, roomId, userId, {
      seated: 1,
      conn_id: `${userId}-conn`,
      hp: 73,
      ready: 1,
    });
  }
  await enterDraining(db);
  const before = await listPlayers(db, roomId);
  const room = (await getRoom(db, roomId))!;
  const started = await db.transaction((tx) =>
    mode === 'quick'
      ? maybeAutoStartTx(tx, roomId, registry, room, 'enforce')
      : startMatchTx(tx, roomId, room, 'enforce'),
  );
  expect(started).toBe(false);
  expect(await listPlayers(db, roomId)).toEqual(before);
  expect(await getRoom(db, roomId)).toMatchObject({
    phase: 'lobby',
    error: '服务器维护中，暂不开始新对局。',
  });
});

it('维护期间拒绝再来一局，保留已完成的对局与玩家记录', async () => {
  const opened = await openSeededDb();
  const db = opened.db;
  const now = Date.now();
  const roomId = 'd'.repeat(24);
  await createRoom(db, {
    id: roomId,
    host: { id: 'host', username: 'host' },
    theme: '重赛契约',
    mode: 'private',
  });
  const identities: SocketAuth[] = ['host', 'guest'].map((userId) => ({
    userId,
    username: userId,
    connId: `${userId}-conn`,
    sessionHash: `${userId}-session`,
    sessionExpires: now + 60_000,
    protocolVersion: WS_PROTOCOL,
  }));
  const registry = new SocketRegistry();
  const stubs = identities.map((identity) => {
    const stub = stubSocket(identity);
    registry.attach(stub.socket, identity);
    return stub;
  });
  const scope: RoomScope = createRoomScope({
    roomId,
    db,
    generate: async () => {
      throw new Error('generation not expected in this test');
    },
    registry,
    inputPolicyMode: 'enforce',
  });
  for (const identity of identities) {
    await insertPlayer(db, roomId, {
      userId: identity.userId,
      username: identity.username,
      slotExpiresAt: null,
      now,
    });
    await updatePlayer(db, roomId, identity.userId, { seated: 1, conn_id: identity.connId });
  }
  await updateRoom(db, roomId, {
    phase: 'finished',
    locked: 1,
    match_id: 'finished-match',
    end_reason: 'timeout',
  });
  const finished = await getRoom(db, roomId);
  const roster = await listPlayers(db, roomId);
  await enterDraining(db);
  await handleClientFrame(scope, stubs[0].socket, identities[0], { type: 'rematch' });
  expect(await getRoom(db, roomId)).toEqual(finished);
  expect(await listPlayers(db, roomId)).toEqual(roster);
});

it('维护中的对局不受影响：比赛照常进行并按原截止时间自然结算', async () => {
  const opened = await openSeededDb();
  const db = opened.db;
  const now = Date.now();
  const roomId = 'e'.repeat(24);
  await createRoom(db, {
    id: roomId,
    host: { id: 'host', username: 'host' },
    theme: '排空契约',
    mode: 'private',
  });
  const registry = new SocketRegistry();
  const scope: RoomScope = createRoomScope({
    roomId,
    db,
    generate: async () => {
      throw new Error('generation not expected in this test');
    },
    registry,
    inputPolicyMode: 'enforce',
  });
  for (const userId of ['host', 'guest']) {
    await insertPlayer(db, roomId, { userId, username: userId, slotExpiresAt: null, now });
    await updatePlayer(db, roomId, userId, { seated: 1, conn_id: `${userId}-conn` });
  }
  const deadline = Date.now() - 1;
  await updateRoom(db, roomId, {
    phase: 'playing',
    locked: 1,
    match_id: 'draining-match',
    deadline,
    started_at: deadline - 240_000,
    input_policy_version: INPUT_POLICY_VERSION,
    input_policy_mode: 'enforce',
    input_min_ms_per_code_point: INPUT_MIN_MS_PER_CODE_POINT,
  });
  for (const userId of ['host', 'guest']) {
    await updatePlayer(db, roomId, userId, {
      input_opened_at: deadline - 1_000,
      input_not_before: deadline - 1_000,
    });
  }
  await enterDraining(db);

  // Maintenance never touches a live match's clock or seats; the past deadline still settles it.
  await advanceOnce(scope);
  const settled = (await getRoom(db, roomId))!;
  expect(settled.phase).toBe('finished');
  expect(settled.end_reason).toBe('timeout');
  expect(settled.ended_at).toBe(deadline);
  // And the settled match cannot quietly become a new one under maintenance either.
  expect(await db.transaction((tx) => startMatchTx(tx, roomId, settled, 'enforce'))).toBe(false);
});

it('无法识别的策略配置拒绝开局，绝不默认，也不碰任何座位', async () => {
  const opened = await openSeededDb();
  const db = opened.db;
  const now = Date.now();
  const roomId = 'f'.repeat(24);
  await createRoom(db, {
    id: roomId,
    host: { id: 'host', username: 'host' },
    theme: '坏配置',
    mode: 'private',
  });
  for (const userId of ['host', 'guest']) {
    await insertPlayer(db, roomId, { userId, username: userId, slotExpiresAt: null, now });
    await updatePlayer(db, roomId, userId, {
      seated: 1,
      conn_id: `${userId}-conn`,
      hp: 7,
      ready: 1,
    });
  }
  const room = (await getRoom(db, roomId))!;

  expect(await db.transaction((tx) => startMatchTx(tx, roomId, room, INVALID_POLICY_MODE))).toBe(
    false,
  );
  expect(await getRoom(db, roomId)).toMatchObject({
    phase: 'lobby',
    error: '施法规则配置异常，暂不能开始新对局。',
  });
  // 损坏的配置不碰任何座位。
  expect(await getPlayer(db, roomId, 'host')).toMatchObject({ hp: 7, ready: 1 });
});
