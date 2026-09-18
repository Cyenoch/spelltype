import { DetailedError } from 'hono/client';
import { WS_CLOSE } from '../../../shared/protocol';
import type { ServerMessage } from '../../../shared/protocol';

export interface CloseInfo {
  code: number;
  reason: string;
  /** The session was rejected: re-authentication is required. */
  authExpired: boolean;
  /** Another connection for the same account took over this seat. */
  replaced: boolean;
  /** The room is gone or no longer admits this player. */
  roomClosed: boolean;
  /** The server runs a different wire protocol: the page must be reloaded. */
  protocolMismatch: boolean;
  /** The server reset this connection because input messages were too dense. */
  inputOverload: boolean;
}

const AUTH_CLOSE_CODES: Record<number, true> = { 1008: true, 4401: true, 4403: true };

/**
 * Decodes one server frame: the discriminant is checked, the frame itself is the
 * room's own snapshot (which every consumer reads through authoritative fields).
 * An unknown or malformed frame is dropped, never guessed at.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || !('type' in value)) return null;
  const { type } = value;
  if (type === 'state' || type === 'error' || type === 'pong') return value as ServerMessage;
  return null;
}

/** Maps a close code to the one situation the room view reacts to. */
export function closeInfo(code: number, reason: string): CloseInfo {
  return {
    code,
    reason,
    authExpired: AUTH_CLOSE_CODES[code] === true || code === WS_CLOSE.sessionExpired,
    replaced: code === WS_CLOSE.replaced,
    roomClosed: code === WS_CLOSE.closed,
    protocolMismatch: code === WS_CLOSE.protocolMismatch,
    inputOverload: code === WS_CLOSE.inputOverload,
  };
}

/** Why the current page cannot keep talking to this server on this socket. */
export type Diagnosis = 'ok' | 'auth' | 'room' | 'protocol';

/**
 * An HTTP 409 carrying the server's required protocol is an update-required verdict,
 * including when a proxy or stale request omitted this page's current version header.
 * Shared by the initial route load and the post-close diagnosis, so both
 * surfaces reach the same terminal "refresh the page" state.
 */
export function isProtocolRejection(error: unknown): boolean {
  if (!(error instanceof DetailedError)) return false;
  if (error.statusCode !== 409) return false;
  const detail: unknown = error.detail;
  if (!detail || typeof detail !== 'object' || !('data' in detail)) return false;
  const body: unknown = detail.data;
  if (!body || typeof body !== 'object' || !('protocolVersion' in body)) return false;
  return typeof body.protocolVersion === 'string' && body.protocolVersion.length > 0;
}
