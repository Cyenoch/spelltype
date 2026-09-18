import { expect, it } from 'vitest';
import type { ServerMessage } from '../../shared/protocol';
import type { Env } from '../../worker/env';
import { handleClientFrame } from '../../worker/rooms/frames';
import { InputBudget, type RoomScope } from '../../worker/rooms/scope';
import { snapshotFor } from '../../worker/rooms/snapshots';
import type { SocketAuth } from '../../worker/rooms/sockets';
import { insertPlayer, updatePlayer } from '../../worker/rooms/storage/players';
import { insertRoom, updateRoom } from '../../worker/rooms/storage/room';
import { createSchema } from '../../worker/rooms/storage/schema';
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
    env: {} as Env,
    input: new InputBudget(),
    alarm: { set: async () => {}, clear: async () => {} },
    sockets: () => sockets,
  };
  try {
    createSchema(storage.sql);
    insertRoom(storage.sql, {
      id: 'a'.repeat(24),
      hostId: 'host',
      mode: 'quick',
      theme: '咒文契约',
      difficulty: 'normal',
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
