import type { ServerWebSocket } from 'bun';
import type { RoomSnapshot, User } from '../shared/protocol';
import type { ServerConfig } from './config';
import type { Database } from './db';
import type { GenerationInput, GenerationOutcome } from './generation/spells';

export interface AuthenticatedSession {
  user: User;
  tokenHash: string;
  expiresAt: number;
}

export interface RoomSocketData {
  roomId: string;
  session: AuthenticatedSession;
  protocolVersion: string;
}

export type RoomSocket = ServerWebSocket<RoomSocketData>;

export type GenerateSpells = (input: GenerationInput) => Promise<GenerationOutcome>;

export type ReleaseProbe = (
  releaseId: string,
) => Promise<{ releaseId: string; runtimeEpoch: number }>;

/** The room runtime owns sockets, serialized commands and durable deadlines. */
export interface RoomRuntimePort {
  readonly releaseId: string;
  readonly runtimeEpoch: number;
  snapshot(roomId: string, user: User): Promise<RoomSnapshot>;
  authorizeSocket(roomId: string, session: AuthenticatedSession): Promise<void>;
  connect(socket: RoomSocket): void;
  message(socket: RoomSocket, message: string | Uint8Array): void;
  disconnect(socket: RoomSocket): void;
  leaveRoom(roomId: string, userId: string): Promise<void>;
  revokeSession(tokenHash: string): Promise<void>;
  refreshRoom(roomId: string): Promise<void>;
  close(): Promise<void>;
}

export interface ServerServices {
  database: Database;
  config: ServerConfig;
  rooms: RoomRuntimePort | null;
}
