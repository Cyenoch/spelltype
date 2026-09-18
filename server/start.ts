import type { Server } from 'bun';
import { Hono } from 'hono';
import { gameApiBase, releaseIdSchema } from '../shared/release';
import { createAssetApp } from './assets';
import type { ServerConfig } from './config';
import type { GenerateSpells, ReleaseProbe, RoomSocketData, ServerServices } from './contracts';
import { openDatabase, type Database } from './db';
import { createSpellModel } from './generation/provider';
import { generateSpellSet } from './generation/spells';
import { createSpellBookGenerator } from './generation/book-cache';
import { createAdminApp, createGameApp, createStableApp, type HttpEnv } from './http/app';
import { ensureDevelopmentRelease } from './releases/control';
import { createRoomRuntime } from './rooms';

export interface StartServerOptions {
  config: ServerConfig;
  generate?: GenerateSpells;
  /** Caller-owned connection: useful when several local runtimes share one PGlite engine. */
  database?: Database;
  releaseProbe?: ReleaseProbe;
}

export interface RunningServer {
  url: string;
  adminUrl: string | null;
  close(): Promise<void>;
}

/** Migration and runtime ownership finish before any listener becomes reachable. */
export async function startServer({
  config,
  generate,
  database,
  releaseProbe,
}: StartServerOptions): Promise<RunningServer> {
  releaseIdSchema.parse(config.releaseId);
  if (config.adminPort !== null && !config.adminToken) {
    throw new Error('An admin listener requires an admin token.');
  }
  const ownedDatabase = database ? null : await openDatabase(config.databaseUrl);
  const connection = database ?? ownedDatabase!.db;
  const services: ServerServices = { database: connection, config, rooms: null };
  let publicServer: Server<RoomSocketData> | undefined;
  let adminServer: Server<undefined> | undefined;
  let closing: Promise<void> | undefined;

  function close(): Promise<void> {
    closing ??= (async () => {
      const stopped = Promise.all([publicServer?.stop(false), adminServer?.stop(false)]);
      const deadline = setTimeout(() => {
        void publicServer?.stop(true);
        void adminServer?.stop(true);
      }, 10_000);
      deadline.unref();
      try {
        await services.rooms?.close();
      } finally {
        try {
          await stopped;
        } finally {
          clearTimeout(deadline);
          await ownedDatabase?.close();
        }
      }
    })();
    return closing;
  }

  try {
    if (config.role === 'all') await ensureDevelopmentRelease(connection, config.releaseId);
    if (config.role !== 'api') {
      services.rooms = await createRoomRuntime({
        database: connection,
        releaseId: config.releaseId,
        inputPolicyMode: config.inputPolicyMode,
        matchAdmission: config.matchAdmission,
        generate: createSpellBookGenerator(
          connection,
          generate ?? ((input) => generateSpellSet(() => createSpellModel(config.ai), input)),
        ),
      });
    }
    const app = new Hono<HttpEnv>();
    if (config.role !== 'game') app.route('/', createStableApp(services));
    if (services.rooms) app.route(gameApiBase(config.releaseId), createGameApp(services));
    if (config.role !== 'game') app.route('/', createAssetApp(services));
    app.notFound((context) => context.json({ error: '未找到请求的资源。' }, 404));

    const rooms = services.rooms;
    publicServer = Bun.serve<RoomSocketData>({
      hostname: config.hostname,
      port: config.port,
      development: false,
      maxRequestBodySize: 64 * 1024,
      fetch: (request, server) => app.fetch(request, { server }),
      websocket: {
        maxPayloadLength: 16 * 1024,
        backpressureLimit: 1024 * 1024,
        closeOnBackpressureLimit: true,
        idleTimeout: 120,
        open(socket) {
          if (!rooms) return socket.close(1011, 'Game runtime unavailable');
          rooms.connect(socket);
        },
        message(socket, message) {
          rooms?.message(socket, message);
        },
        close(socket) {
          rooms?.disconnect(socket);
        },
      },
    });
    if (config.adminPort !== null) {
      const admin = createAdminApp(services, releaseProbe);
      adminServer = Bun.serve({
        hostname: config.hostname,
        port: config.adminPort,
        development: false,
        maxRequestBodySize: 16 * 1024,
        fetch: (request) => admin.fetch(request),
      });
    }
    return { url: publicServer.url.origin, adminUrl: adminServer?.url.origin ?? null, close };
  } catch (error) {
    await close();
    throw error;
  }
}
