/**
 * 基于真实底层存储的房间运行时：30 天的超长会话绝不能导致原生房间定时器溢出，
 * 且房间创建通过所有运行时通用的持久化准入路径进行。
 */
import { expect, it } from 'bun:test';
import type { AuthenticatedSession, RoomRuntimePort, RoomSocketData } from '../../server/contracts';
import { openDatabase } from '../../server/db';
import { accounts, sessions } from '../../server/db/schema';
import { createRoom, createRoomRuntime } from '../../server/rooms';
import { WS_PROTOCOL } from '../../shared/protocol';
import type { ServerMessage } from '../../shared/protocol';

it('防止常规的 30 天超长会话导致原生房间定时器溢出', async () => {
  const database = await openDatabase('pglite://:memory:');
  const now = Date.now();
  const user = { id: 'timer-user', username: 'timer_user' };
  const session: AuthenticatedSession = {
    user,
    role: 'user',
    tokenHash: 'f'.repeat(64),
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
  };
  const roomId = '1234567890abcdef12345678';
  await database.db.insert(accounts).values({
    id: user.id,
    username: user.username,
    wechat_identity: `union:${user.id}`,
    created_at: now,
  });
  await database.db.insert(sessions).values({
    token_hash: session.tokenHash,
    user_id: user.id,
    expires_at: session.expiresAt,
  });
  await createRoom(database.db, {
    id: roomId,
    host: user,
    theme: '长会话计时器',
    mode: 'private',
  });
  const runtime: RoomRuntimePort = await createRoomRuntime({
    database: database.db,
    inputPolicyMode: 'enforce',
    generate: async () => {
      throw new Error('Generation is not used in this lobby test');
    },
  });
  const server = Bun.serve<RoomSocketData>({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request, server) {
      await runtime.authorizeSocket(roomId, session);
      if (server.upgrade(request, { data: { roomId, session, protocolVersion: WS_PROTOCOL } }))
        return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open: (socket) => runtime.connect(socket),
      message: (socket, message) => runtime.message(socket, message),
      close: (socket) => runtime.disconnect(socket),
    },
  });
  const overflows: string[] = [];
  const onWarning = (warning: Error): void => {
    if (warning.name === 'TimeoutOverflowWarning') overflows.push(warning.message);
  };
  process.on('warning', onWarning);
  const connected = Promise.withResolvers<void>();
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`);
  try {
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = JSON.parse(event.data) as ServerMessage;
      if (message.type === 'state') connected.resolve();
      else if (message.type === 'error') connected.reject(new Error(message.message));
    });
    socket.addEventListener('error', () => connected.reject(new Error('Room WebSocket failed')));
    socket.addEventListener('close', () =>
      connected.reject(new Error('Room WebSocket closed before joining')),
    );
    await connected.promise;
    // 溢出的超时会被限制为 1ms，并立即启动重复的赶超循环。
    await Bun.sleep(100);
    expect(overflows).toEqual([]);
  } finally {
    socket.close();
    await runtime.close();
    await server.stop(true);
    await database.close();
    process.off('warning', onWarning);
  }
}, 15_000);
