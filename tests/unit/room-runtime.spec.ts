import { expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { AuthenticatedSession, RoomRuntimePort, RoomSocketData } from '../../server/contracts';
import { openDatabase } from '../../server/db';
import { accounts, players, rooms, sessions } from '../../server/db/schema';
import {
  ensureDevelopmentRelease,
  stageRelease,
  withAdmission,
} from '../../server/releases/control';
import { createRoom, createRoomRuntime } from '../../server/rooms';
import { DEV_RELEASE_ID } from '../../shared/release';
import { WS_PROTOCOL } from '../../shared/protocol';
import type { ServerMessage } from '../../shared/protocol';

/** A second build registered through staging but never activated: rooms may reference it. */
const FOREIGN_RELEASE_ID = 'e'.repeat(32);

it('keeps a normal 30-day session from overflowing the native room timer', async () => {
  const database = await openDatabase('pglite://:memory:');
  const now = Date.now();
  const user = { id: 'timer-user', username: 'timer_user' };
  const session: AuthenticatedSession = {
    user,
    tokenHash: 'f'.repeat(64),
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
  };
  const roomId = '1234567890abcdef12345678';
  await database.db.insert(accounts).values({
    ...user,
    password_hash: 'unused-by-room-runtime',
    username_key: user.username,
    created_at: now,
  });
  await database.db.insert(sessions).values({
    token_hash: session.tokenHash,
    user_id: user.id,
    expires_at: session.expiresAt,
  });
  await ensureDevelopmentRelease(database.db, DEV_RELEASE_ID);
  await withAdmission(database.db, DEV_RELEASE_ID, (tx) =>
    createRoom(tx, {
      id: roomId,
      releaseId: DEV_RELEASE_ID,
      host: user,
      theme: '长会话计时器',
      mode: 'private',
    }),
  );
  const runtime = await createRoomRuntime({
    database: database.db,
    releaseId: DEV_RELEASE_ID,
    matchAdmission: 'open',
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
    // An overflowing timeout is clamped to 1ms and immediately starts a repeating catch-up loop.
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

/**
 * The adoption guard: a runtime refuses to start while an ACTIVE room of its OWN
 * release carries no locked input policy — a match it could neither judge nor
 * settle. Rooms of other releases are never fenced by it, and settled history
 * needs no policy at all.
 */
it('refuses unmeasured active rooms of its own release without fencing other releases', async () => {
  const database = await openDatabase('pglite://:memory:');
  let runtime: RoomRuntimePort | null = null;
  try {
    const now = Date.now();
    await ensureDevelopmentRelease(database.db, DEV_RELEASE_ID);
    // The foreign build is registered through the normal staging API — never a second dev
    // bootstrap, which would try to repoint the one admission pointer and conflict.
    await stageRelease(database.db, {
      operationId: 'runtime-adoption-fixture',
      releaseId: FOREIGN_RELEASE_ID,
      artifactDigest: 'runtime-adoption-fixture-artifact',
    });
    const ownActive = 'aaa000000000000000000001';
    const foreignActive = 'aaa000000000000000000002';
    const ownFinished = 'aaa000000000000000000003';
    for (const [id, releaseId, phase] of [
      [ownActive, DEV_RELEASE_ID, 'playing'],
      [foreignActive, FOREIGN_RELEASE_ID, 'playing'],
      [ownFinished, DEV_RELEASE_ID, 'finished'],
    ] as const) {
      await database.db.insert(rooms).values({
        id,
        release_id: releaseId,
        host_id: 'host-1',
        mode: 'private',
        theme: '守卫契约',
        difficulty: 'hard',
        phase,
        match_id: `match-${id.slice(-2)}`,
        deadline: now + 60_000,
        created_at: now,
        updated_at: now,
      });
      await database.db.insert(players).values({
        room_id: id,
        user_id: 'host-1',
        username: 'host-1',
        slot: 0,
        joined_at: now,
      });
    }

    // An unmeasured active room of the runtime's own release blocks the startup:
    // the guard refuses before any room is adopted, with the drain-required reason.
    expect(
      createRoomRuntime({
        database: database.db,
        releaseId: DEV_RELEASE_ID,
        matchAdmission: 'open',
        inputPolicyMode: 'enforce',
        generate: async () => {
          throw new Error('not expected');
        },
      }),
    ).rejects.toThrow('input_policy_drain_required');

    // The staged foreign release and its rooms are nobody else's business: the failed
    // check above must not have fenced the database or the other release's rooms.
    const foreign = await database.db
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.release_id, FOREIGN_RELEASE_ID));
    expect(foreign.map((row) => row.id)).toEqual([foreignActive]);

    // A runtime for a release with no unmeasured active rooms starts normally:
    // the finished own-release room needs no policy, and a staged foreign release
    // can hold its runtime lease before activation (the health-check path).
    await database.db.delete(rooms).where(eq(rooms.id, foreignActive));
    runtime = await createRoomRuntime({
      database: database.db,
      releaseId: FOREIGN_RELEASE_ID,
      matchAdmission: 'open',
      inputPolicyMode: 'enforce',
      generate: async () => {
        throw new Error('not expected');
      },
    });
    expect(runtime.releaseId).toBe(FOREIGN_RELEASE_ID);
  } finally {
    if (runtime !== null) await runtime.close();
    await database.close();
  }
}, 15_000);
