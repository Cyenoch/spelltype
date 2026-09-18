import type { Difficulty } from '../../shared/protocol';
import type { SqlStore } from '../sql';

/** Terminal states of one account's single ticket. */
export type TicketState = 'waiting' | 'matched' | 'cancelling';

/**
 * Rows keep their `difficulty` column as historical storage (existing databases are never
 * re-migrated); every row written today stores the one value, `'hard'`.
 */
export type TicketRow = {
  user_id: string;
  username: string;
  request_id: string;
  difficulty: Difficulty;
  state: TicketState;
  room_id: string | null;
  expires_at: number;
  updated_at: number;
};

/** The fields a cancellation needs; the ticket's state is irrelevant to the queue handshake. */
export type CancelTarget = Pick<TicketRow, 'user_id' | 'request_id'>;

/** One account waiting for a partner in the queue. */
export type WaitingRow = {
  user_id: string;
  username: string;
  request_id: string;
  difficulty: Difficulty;
  enqueued_at: number;
  expires_at: number;
};

/** One pairing attempt and the quick room it reserved. */
export type PairingRow = {
  room_id: string;
  user_a: string;
  request_a: string;
  user_b: string;
  request_b: string;
  state: 'preparing' | 'ready' | 'released';
  cleanup: number;
  difficulty: Difficulty;
  expires_at: number;
  created_at: number;
};

/** What the account shard asks the queue to join with. */
export type QueueEntry = {
  userId: string;
  username: string;
  requestId: string;
  expiresAt: number;
};

/** A ready pairing as seen by one of its two accounts. */
export type ClaimedPairing = {
  room_id: string;
  request_id: string;
  expires_at: number;
};

const TICKET_SCHEMA = `CREATE TABLE IF NOT EXISTS ticket (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  request_id TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  state TEXT NOT NULL,
  room_id TEXT,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)`;

const WAITING_SCHEMA = `CREATE TABLE IF NOT EXISTS waiting (
  user_id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  request_id TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
)`;

const PAIRING_SCHEMA = `CREATE TABLE IF NOT EXISTS pairing (
  room_id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL,
  request_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  request_b TEXT NOT NULL,
  state TEXT NOT NULL,
  cleanup INTEGER NOT NULL DEFAULT 0,
  difficulty TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
)`;

/**
 * Opens a shard's database, once per instance under `blockConcurrencyWhile`. A coordinator keeps the
 * ticket table, a queue shard the waiting and pairing tables; both are created so a shard can never
 * be half-initialized whichever role its name selected, and an existing shard is left as it is.
 */
export function createSchema(sql: SqlStore): void {
  sql.exec(TICKET_SCHEMA);
  sql.exec(WAITING_SCHEMA);
  sql.exec(PAIRING_SCHEMA);
}
