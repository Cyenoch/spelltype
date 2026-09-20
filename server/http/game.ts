import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { WS_PROTOCOL } from '../../shared/protocol';
import { MaintenanceError } from '../../shared/maintenance';
import { createRoomSchema } from '../../shared/validation';
import { withAdmission } from '../maintenance/control';
import { acquireMatch, cancelMatch, newRoomId } from '../matchmaking';
import { createRoom } from '../rooms/storage/room';
import {
  authenticate,
  authenticated,
  banRejectionMessage,
  mapGameError,
  notBanned,
  protocolGate,
  requireRuntime,
  roomIdGate,
  sameOrigin,
  zodReject,
  type HttpEnv,
} from './context';

export const gameRoutes = new Hono<HttpEnv>({ strict: false })
  .post(
    '/rooms',
    sameOrigin,
    protocolGate,
    authenticated,
    notBanned,
    zValidator('json', createRoomSchema, zodReject),
    async (c) => {
      const { theme } = c.req.valid('json');
      const { database } = c.get('services');
      const runtime = requireRuntime(c);
      const host = c.get('session').user;
      const roomId = newRoomId();
      try {
        await withAdmission(database, async (tx) => {
          await runtime.assertOwnership(tx);
          await createRoom(tx, { id: roomId, host, theme, mode: 'private' });
        });
        await runtime.refreshRoom(roomId);
      } catch (error) {
        throw mapGameError(error);
      }
      return c.json({ roomId });
    },
  )
  .get('/rooms/:roomId', protocolGate, authenticated, notBanned, roomIdGate, async (c) => {
    try {
      return c.json(await requireRuntime(c).snapshot(c.req.param('roomId'), c.get('session').user));
    } catch (error) {
      throw mapGameError(error);
    }
  })
  .post(
    '/rooms/:roomId/leave',
    sameOrigin,
    protocolGate,
    authenticated,
    notBanned,
    roomIdGate,
    async (c) => {
      try {
        await requireRuntime(c).leaveRoom(c.req.param('roomId'), c.get('session').user.id);
      } catch (error) {
        throw mapGameError(error);
      }
      return c.json({ left: true as const });
    },
  )
  .get('/rooms/:roomId/ws', sameOrigin, roomIdGate, async (c) => {
    const runtime = requireRuntime(c);
    if ((c.req.header('upgrade') ?? '').toLowerCase() !== 'websocket') {
      throw new HTTPException(426, { message: '需要 WebSocket 升级请求' });
    }
    if (
      !c.req
        .header('Sec-WebSocket-Protocol')
        ?.split(',')
        .some((value) => value.trim() === WS_PROTOCOL)
    ) {
      return c.json(
        {
          code: 'protocol:mismatch' as const,
          error: '客户端版本已更新，请刷新页面后继续。',
          protocolVersion: WS_PROTOCOL,
        },
        426,
      );
    }
    const session = await authenticate(c);
    if (session.ban !== null) {
      throw new HTTPException(403, { message: banRejectionMessage(session.ban) });
    }
    const roomId = c.req.param('roomId');
    try {
      await runtime.authorizeSocket(roomId, session);
    } catch (error) {
      throw mapGameError(error);
    }
    const server = c.env?.server;
    if (!server) throw new MaintenanceError('maintenance:unavailable');
    const upgraded = server.upgrade(c.req.raw, {
      data: { roomId, session, protocolVersion: WS_PROTOCOL },
      headers: { 'Sec-WebSocket-Protocol': WS_PROTOCOL },
    });
    if (!upgraded) throw new HTTPException(426, { message: '需要 WebSocket 升级请求' });
    return new Response(null);
  })
  .post('/match', sameOrigin, protocolGate, authenticated, notBanned, async (c) => {
    const runtime = requireRuntime(c);
    try {
      return c.json(
        await acquireMatch(c.get('services').database, c.get('session').user, (tx) =>
          runtime.assertOwnership(tx),
        ),
      );
    } catch (error) {
      throw mapGameError(error);
    }
  })
  .delete('/match', sameOrigin, protocolGate, authenticated, notBanned, async (c) => {
    const runtime = requireRuntime(c);
    try {
      const outcome = await cancelMatch(
        c.get('services').database,
        c.get('session').user.id,
        (tx) => runtime.assertOwnership(tx),
      );
      if (outcome.cancelled && outcome.roomId) await runtime.refreshRoom(outcome.roomId);
      return c.json({ cancelled: outcome.cancelled });
    } catch (error) {
      throw mapGameError(error);
    }
  });
