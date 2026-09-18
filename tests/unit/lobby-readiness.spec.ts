import { expect, it } from 'vitest';
import { WS_PROTOCOL, type ServerMessage } from '../../shared/protocol';
import type { Env } from '../../worker/env';
import { handleClientFrame } from '../../worker/rooms/frames';
import { maybeAutoStart, startMatch } from '../../worker/rooms/match';
import { listPlayers } from '../../worker/rooms/storage/players';
import { getRoom } from '../../worker/rooms/storage/room';
import { InputBudget, type RoomScope } from '../../worker/rooms/scope';
import { snapshotFor } from '../../worker/rooms/snapshots';
import type { SocketAuth } from '../../worker/rooms/sockets';
import { insertPlayer, updatePlayer } from '../../worker/rooms/storage/players';
import { insertRoom, updateRoom } from '../../worker/rooms/storage/room';
import { createSchema } from '../../worker/rooms/storage/schema';
import { advanceOnce } from '../../worker/rooms/transitions';
import { openTestStorage } from '../support/sql-storage';

it('生成咒文期间准备与取消准备会同步给双方，倒计时开始后拒绝变更', async () => {
  const storage = openTestStorage();
  const now = Date.now();
  const received: ServerMessage[][] = [[], []];
  const identities: SocketAuth[] = ['host', 'guest'].map((userId) => ({
    userId,
    username: userId,
    connId: `${userId}-connection`,
    sessionHash: `${userId}-session`,
    sessionExpires: now + 60_000,
    protocolVersion: WS_PROTOCOL,
  }));
  // Only the platform transport is substituted; frames, state changes and snapshots are real.
  const sockets = identities.map(
    (identity, index) =>
      ({
        readyState: WebSocket.OPEN,
        deserializeAttachment: () => identity,
        send: (data: string) => received[index].push(JSON.parse(data) as ServerMessage),
      }) as unknown as WebSocket,
  );
  const scope: RoomScope = {
    sql: storage.sql,
    env: { MATCH_ADMISSION: 'open' } as Env,
    input: new InputBudget(),
    alarm: { set: async () => {}, clear: async () => {} },
    sockets: () => sockets,
    transactionSync: storage.transactionSync,
  };
  try {
    createSchema(storage.sql);
    insertRoom(storage.sql, {
      id: 'a'.repeat(24),
      hostId: 'host',
      mode: 'quick',
      theme: '咒文契约',
      difficulty: 'hard',
      reservationState: 'locked',
      reservationExpiresAt: null,
      now,
    });
    for (const identity of identities) {
      insertPlayer(storage.sql, {
        userId: identity.userId,
        username: identity.username,
        slotExpiresAt: null,
        now,
      });
      updatePlayer(storage.sql, identity.userId, { seated: 1, conn_id: identity.connId });
    }
    updateRoom(storage.sql, { phase: 'generating', locked: 1 });
    for (const ready of [true, false]) {
      await handleClientFrame(scope, sockets[1], identities[1], { type: 'ready', ready });
      expect(received[1].at(-1)?.type).toBe('state');
      for (const messages of received) {
        const message = messages.at(-1);
        expect(message?.type).toBe('state');
        if (message?.type !== 'state') throw new Error('Expected a room snapshot');
        expect(message.room.phase).toBe('generating');
        expect(message.room.startedAt).toBeNull();
        expect(message.room.players.find((player) => player.id === 'guest')?.ready).toBe(ready);
      }
    }
    for (const phase of ['countdown', 'playing'] as const) {
      updateRoom(storage.sql, { phase });
      await handleClientFrame(scope, sockets[1], identities[1], { type: 'ready', ready: true });
      expect(received[1].at(-1)?.type).toBe('error');
      expect(
        snapshotFor(scope, { id: 'guest', username: 'guest' }).players.find(
          (player) => player.id === 'guest',
        )?.ready,
      ).toBe(false);
    }
  } finally {
    storage.close();
  }
});

it.each(['private', 'quick'] as const)('维护期间不锁定 %s 房间或重置已有座位', (mode) => {
  const storage = openTestStorage();
  const now = Date.now();
  const identities: SocketAuth[] = ['host', 'guest'].map((userId) => ({
    userId,
    username: userId,
    connId: userId,
    sessionHash: userId,
    sessionExpires: now + 60_000,
    protocolVersion: WS_PROTOCOL,
  }));
  const scope: RoomScope = {
    sql: storage.sql,
    env: { MATCH_ADMISSION: 'draining' } as Env,
    input: new InputBudget(),
    alarm: { set: async () => {}, clear: async () => {} },
    sockets: () =>
      identities.map(
        (meta) => ({ readyState: WebSocket.OPEN, deserializeAttachment: () => meta }) as WebSocket,
      ),
    transactionSync: storage.transactionSync,
  };
  try {
    createSchema(storage.sql);
    insertRoom(storage.sql, {
      id: 'b'.repeat(24),
      hostId: 'host',
      mode,
      theme: '维护',
      difficulty: 'hard',
      reservationState: mode === 'quick' ? 'reserved' : 'none',
      reservationExpiresAt: now + 60_000,
      now,
    });
    for (const meta of identities) {
      insertPlayer(storage.sql, {
        userId: meta.userId,
        username: meta.username,
        slotExpiresAt: null,
        now,
      });
      updatePlayer(storage.sql, meta.userId, { seated: 1, conn_id: meta.connId, hp: 73, ready: 1 });
    }
    const before = listPlayers(storage.sql);
    const room = getRoom(storage.sql)!;
    expect(mode === 'quick' ? maybeAutoStart(scope, room) : startMatch(scope, room)).toBe(false);
    expect(listPlayers(storage.sql)).toEqual(before);
    expect(getRoom(storage.sql)).toEqual({
      ...room,
      error: expect.any(String),
      updated_at: expect.any(Number),
    });
  } finally {
    storage.close();
  }
});

it('维护期间已结束的局可以重置回大厅，但再次开局仍被拒绝', async () => {
  const storage = openTestStorage();
  const now = Date.now();
  const identities: SocketAuth[] = ['host', 'guest'].map((userId) => ({
    userId,
    username: userId,
    connId: `${userId}-conn`,
    sessionHash: `${userId}-session`,
    sessionExpires: now + 60_000,
    protocolVersion: WS_PROTOCOL,
  }));
  const sockets = identities.map(
    (identity) =>
      ({
        readyState: WebSocket.OPEN,
        deserializeAttachment: () => identity,
        send: () => {},
      }) as unknown as WebSocket,
  );
  const draining: Env = { MATCH_ADMISSION: 'draining' } as Env;
  const scope: RoomScope = {
    sql: storage.sql,
    env: draining,
    input: new InputBudget(),
    alarm: { set: async () => {}, clear: async () => {} },
    sockets: () => sockets,
    transactionSync: storage.transactionSync,
  };
  try {
    createSchema(storage.sql);
    insertRoom(storage.sql, {
      id: 'c'.repeat(24),
      hostId: 'host',
      mode: 'private',
      theme: '重赛契约',
      difficulty: 'hard',
      reservationState: 'none',
      reservationExpiresAt: null,
      now,
    });
    for (const meta of identities) {
      insertPlayer(storage.sql, {
        userId: meta.userId,
        username: meta.username,
        slotExpiresAt: null,
        now,
      });
      updatePlayer(storage.sql, meta.userId, { seated: 1, conn_id: meta.connId });
    }
    updateRoom(storage.sql, {
      phase: 'finished',
      locked: 1,
      match_id: 'finished-match',
      end_reason: 'timeout',
    });
    await handleClientFrame(scope, sockets[0], identities[0], { type: 'rematch' });
    const lobby = getRoom(storage.sql)!;
    expect(lobby.phase).toBe('lobby');
    expect(lobby.locked).toBe(0);
    expect(lobby.match_id).toBeNull();

    // The rematch itself is a lobby reset, not a new match: the next start is what draining blocks.
    const roster = listPlayers(storage.sql);
    expect(startMatch(scope, getRoom(storage.sql)!)).toBe(false);
    expect(listPlayers(storage.sql)).toEqual(roster);
    expect(getRoom(storage.sql)!.error).toBe('服务器维护中，暂不开始新对局。');
    // The refused start must not have consumed the lobby either: phase and seats survive intact.
    expect(getRoom(storage.sql)!.phase).toBe('lobby');
  } finally {
    storage.close();
  }
});

it('维护中的对局不受影响：比赛照常进行并按原截止时间自然结算', async () => {
  const storage = openTestStorage();
  const now = Date.now();
  const identities: SocketAuth[] = ['host', 'guest'].map((userId) => ({
    userId,
    username: userId,
    connId: `${userId}-conn`,
    sessionHash: `${userId}-session`,
    sessionExpires: now + 60_000,
    protocolVersion: WS_PROTOCOL,
  }));
  const sockets = identities.map(
    (identity) =>
      ({
        readyState: WebSocket.OPEN,
        deserializeAttachment: () => identity,
        send: () => {},
      }) as unknown as WebSocket,
  );
  const scope: RoomScope = {
    sql: storage.sql,
    env: { MATCH_ADMISSION: 'draining' } as Env,
    input: new InputBudget(),
    alarm: { set: async () => {}, clear: async () => {} },
    sockets: () => sockets,
    transactionSync: storage.transactionSync,
  };
  try {
    createSchema(storage.sql);
    insertRoom(storage.sql, {
      id: 'd'.repeat(24),
      hostId: 'host',
      mode: 'private',
      theme: '排空契约',
      difficulty: 'hard',
      reservationState: 'none',
      reservationExpiresAt: null,
      now,
    });
    for (const meta of identities) {
      insertPlayer(storage.sql, {
        userId: meta.userId,
        username: meta.username,
        slotExpiresAt: null,
        now,
      });
      updatePlayer(storage.sql, meta.userId, { seated: 1, conn_id: meta.connId });
    }
    const deadline = Date.now() - 1;
    updateRoom(storage.sql, {
      phase: 'playing',
      locked: 1,
      match_id: 'draining-match',
      deadline,
      started_at: deadline - 240_000,
      input_policy_version: 'ascii-floor-v1',
      input_policy_mode: 'enforce',
      input_min_ms_per_code_point: 35,
    });
    updatePlayer(storage.sql, 'host', {
      input_opened_at: deadline - 1_000,
      input_not_before: deadline - 1_000,
    });
    updatePlayer(storage.sql, 'guest', {
      input_opened_at: deadline - 1_000,
      input_not_before: deadline - 1_000,
    });

    // Draining never touches a live match's clock or seats; the past deadline still settles it.
    await advanceOnce(scope);
    const settled = getRoom(storage.sql)!;
    expect(settled.phase).toBe('finished');
    expect(settled.end_reason).toBe('timeout');
    expect(settled.ended_at).toBe(deadline);
    // And the settled match cannot quietly become a new one under draining either.
    expect(startMatch(scope, settled)).toBe(false);
  } finally {
    storage.close();
  }
});

it('无法识别的准入配置拒绝开局，绝不默认为开放', async () => {
  const storage = openTestStorage();
  const now = Date.now();
  const identities: SocketAuth[] = ['host', 'guest'].map((userId) => ({
    userId,
    username: userId,
    connId: `${userId}-conn`,
    sessionHash: `${userId}-session`,
    sessionExpires: now + 60_000,
    protocolVersion: WS_PROTOCOL,
  }));
  const sockets = identities.map(
    (identity) =>
      ({
        readyState: WebSocket.OPEN,
        deserializeAttachment: () => identity,
        send: () => {},
      }) as unknown as WebSocket,
  );
  const scope: RoomScope = {
    sql: storage.sql,
    env: { MATCH_ADMISSION: 'bogus-config' } as unknown as Env,
    input: new InputBudget(),
    alarm: { set: async () => {}, clear: async () => {} },
    sockets: () => sockets,
    transactionSync: storage.transactionSync,
  };
  try {
    createSchema(storage.sql);
    insertRoom(storage.sql, {
      id: 'e'.repeat(24),
      hostId: 'host',
      mode: 'private',
      theme: '配置契约',
      difficulty: 'hard',
      reservationState: 'none',
      reservationExpiresAt: null,
      now,
    });
    for (const meta of identities) {
      insertPlayer(storage.sql, {
        userId: meta.userId,
        username: meta.username,
        slotExpiresAt: null,
        now,
      });
      updatePlayer(storage.sql, meta.userId, { seated: 1, conn_id: meta.connId, ready: 1 });
    }
    const before = listPlayers(storage.sql);
    expect(startMatch(scope, getRoom(storage.sql)!)).toBe(false);
    expect(listPlayers(storage.sql)).toEqual(before);
    expect(getRoom(storage.sql)!.phase).toBe('lobby');
    expect(getRoom(storage.sql)!.error).toBe('服务器维护中，暂不开始新对局。');
    expect(getRoom(storage.sql)!.match_id).toBeNull();
  } finally {
    storage.close();
  }
});
