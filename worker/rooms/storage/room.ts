import type { Difficulty, ReservationState, RoomMode } from '../../../shared/protocol';
import type { RoomRow } from './schema';
import type { SqlStore } from '../../sql';

/** Columns a patch may name; everything else on the row is fixed after creation. */
const ROOM_COLUMNS = new Set<string>([
  'host_id',
  'phase',
  'deadline',
  'started_at',
  'ended_at',
  'end_reason',
  'match_id',
  'spell_book',
  'events_json',
  'event_seq',
  'error',
  'generation_token',
  'generation_claim',
  'generation_seq',
  'reservation_state',
  'reservation_expires_at',
  'locked',
  'persistence',
  'persist_attempts',
  'persist_retry_at',
]);

export type RoomPatch = Partial<Omit<RoomRow, 'singleton' | 'id' | 'created_at' | 'updated_at'>>;

export function insertRoom(
  sql: SqlStore,
  room: {
    id: string;
    hostId: string;
    mode: RoomMode;
    theme: string;
    difficulty: Difficulty;
    reservationState: ReservationState;
    reservationExpiresAt: number | null;
    now: number;
  },
): void {
  sql.exec(
    `INSERT INTO room (
      singleton, id, host_id, mode, theme, difficulty, phase, deadline, started_at, ended_at, end_reason,
      match_id, spell_book, events_json, event_seq, error, generation_token, generation_claim, generation_seq,
      reservation_state, reservation_expires_at, locked, persistence, persist_attempts, persist_retry_at,
      created_at, updated_at
    ) VALUES (1, ?, ?, ?, ?, ?, 'lobby', 0, NULL, NULL, NULL, NULL, NULL, '[]', 0, NULL, NULL, NULL, 0,
      ?, ?, 0, 'idle', 0, NULL, ?, ?)`,
    room.id,
    room.hostId,
    room.mode,
    room.theme,
    room.difficulty,
    room.reservationState,
    room.reservationExpiresAt,
    room.now,
    room.now,
  );
}

export function getRoom(sql: SqlStore): RoomRow | null {
  const rows = sql.exec<RoomRow>('SELECT * FROM room WHERE singleton = 1').toArray();
  return rows.length > 0 ? rows[0] : null;
}

/** Applies a patch over the known columns only, so a caller can never inject a column and every write touches `updated_at`. */
export function updateRoom(sql: SqlStore, patch: RoomPatch): void {
  const keys = Object.keys(patch).filter((key) => ROOM_COLUMNS.has(key));
  if (keys.length === 0) return;
  const assignments = keys.map((key) => `${key} = ?`).join(', ');
  const values = keys.map((key) => (patch as Record<string, string | number | null>)[key] ?? null);
  sql.exec(
    `UPDATE room SET ${assignments}, updated_at = ? WHERE singleton = 1`,
    ...values,
    Date.now(),
  );
}
