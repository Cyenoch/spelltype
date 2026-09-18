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
  };
}
