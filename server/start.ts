import type { Server } from 'bun';
import { Hono } from 'hono';
import { join } from 'node:path';
import { createAssetApp } from './assets';
import type { ServerConfig } from './config';
import type { GenerateSpells, RoomSocketData, ServerServices } from './contracts';
import { openDatabase, type Database } from './db';
import { createSpellModel } from './generation/provider';
import { generateSpellSet } from './generation/spells';
import { createSpellBookGenerator } from './generation/book-cache';
import { createApp } from './http/app';
import type { HttpEnv } from './http/context';
import { createRoomRuntime } from './rooms';

export interface StartServerOptions {
  config: ServerConfig;
  generate?: GenerateSpells;
  /** 由调用方持有的连接；服务器绝不关闭外部注入的数据库。 */
  database?: Database;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

/** 在监听之前先应用待处理迁移，并取得唯一写入者所有权。 */
export async function startServer({
  config,
  generate,
  database,
}: StartServerOptions): Promise<RunningServer> {
  if (config.assetsRoot && !(await Bun.file(join(config.assetsRoot, 'index.html')).exists())) {
    throw new Error('Application assets are missing. Build the application before starting it.');
  }
  const ownedDatabase = database ? null : await openDatabase(config.databaseUrl);
  const connection = database ?? ownedDatabase!.db;
  const services: ServerServices = { database: connection, config, rooms: null };
  let publicServer: Server<RoomSocketData> | undefined;
  let closing: Promise<void> | undefined;

  function close(): Promise<void> {
    closing ??= (async () => {
      const stopped = publicServer?.stop(false);
      const deadline = setTimeout(() => {
        void publicServer?.stop(true);
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
    services.rooms = await createRoomRuntime({
      database: connection,
      inputPolicyMode: config.inputPolicyMode,
      generate: createSpellBookGenerator(
        connection,
        generate ?? ((input) => generateSpellSet(() => createSpellModel(config.ai), input)),
      ),
    });
    const app = new Hono<HttpEnv>()
      .route('/', createApp(services))
      .route('/', createAssetApp(config.assetsRoot));
    app.notFound((c) => c.json({ error: '未找到请求的资源。' }, 404));
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
        open: (socket) => rooms.connect(socket),
        message: (socket, message) => rooms.message(socket, message),
        close: (socket) => rooms.disconnect(socket),
      },
    });
    return { url: publicServer.url.origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}
