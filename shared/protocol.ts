/**
 * Shared wire contract for the browser client, the outer Worker and the Durable Objects.
 * Everything that crosses the network boundary is described here.
 *
 * The game is continuous health combat: one generated spell book, one board of players who trade
 * damage until a single player is left or the single match deadline passes.
 *
 * Every type that also has a runtime validator is inferred from its `shared/validation.ts` schema
 * through a type-only import, so a shape is declared exactly once and the two can never drift.
 */
import type { z } from 'zod';
import type {
  clientMessageSchema,
  difficultySchema,
  elementSchema,
  roomInitSchema,
  roomModeSchema,
} from './validation';

export type Difficulty = z.infer<typeof difficultySchema>;
export type Element = z.infer<typeof elementSchema>;
/** How a room came to exist: a host's private table, or a matchmaker pairing. */
export type RoomMode = z.infer<typeof roomModeSchema>;
export type Phase = 'lobby' | 'generating' | 'countdown' | 'playing' | 'finished';
/** Why a finished match ended: the last opponent fell, or the match deadline passed. */
export type EndReason = 'elimination' | 'timeout';
/** Persistence of the finished-match result into D1, as seen by the room. */
export type Persistence = 'idle' | 'saving' | 'saved' | 'error';
/** Reservation lifecycle of a room seat, used to reconcile matchmaking tickets. */
export type ReservationState = 'none' | 'reserved' | 'cancelled' | 'expired' | 'locked';

/** Limits. Shared so the browser, the Worker and the rooms agree on the boundary values. */
export const MAX_THEME_CHARS = 80;
export const MAX_INPUT_CHARS = 256;
export const MAX_MESSAGE_BYTES = 4096;
export const MAX_API_BODY_BYTES = 8192;
export const MAX_PRIVATE_PLAYERS = 4;
export const MAX_QUICK_PLAYERS = 2;
/** Quick-match seat reservation lifetime, mirrored in MatchTicket.expiresAt. */
export const RESERVATION_TTL_MS = 60_000;
/** Lifetime of a matchmaking queue entry; refreshed by each status poll. */
export const QUEUE_ENTRY_TTL_MS = 60_000;
export const USERNAME_MIN_CHARS = 2;
export const USERNAME_MAX_CHARS = 20;
export const PASSWORD_MIN_CHARS = 10;
export const PASSWORD_MAX_CHARS = 128;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Combat rules. The room is authoritative for all of them; the client only needs the same numbers
 * to render health, the spell counter and the clock without waiting for a snapshot.
 */
/** One 3s opening countdown, then a single uninterrupted combat phase of this length. */
export const OPENING_COUNTDOWN_MS = 3_000;
/** Total active combat time. The match deadline is set once and never extends. */
export const MATCH_DURATION_MS = 240_000;
/** Every player starts, and is capped, at full health. */
export const INITIAL_HEALTH = 2400;
/** Damage per Unicode code point of a completed spell: `4 * [...text].length`, bounded by remaining HP. */
export const DAMAGE_PER_CHARACTER = 4;
/**
 * One shared generated, ordered spell book per match. Every player receives only their own current
 * spell, walked with a private zero-based index; index `mod SPELL_BOOK_SIZE` wraps to the same
 * distinct spell, so a match longer than the book repeats practice spells instead of deadlocking.
 */
export const SPELL_BOOK_SIZE = 24;
/** How many recent CombatEvents the room keeps and republishes (ring, newest last). */
export const COMBAT_EVENT_RING_SIZE = 32;

export interface User {
  id: string;
  username: string;
}

export interface Spell {
  name: string;
  text: string;
  element: Element;
}

export interface Player extends User {
  /** Stable seat slot, 0-based; automatic targeting walks slots clockwise from the attacker. */
  slot: number;
  connected: boolean;
  ready: boolean;
  /** Length of the longest accepted prefix of this player's current spell text. */
  progress: number;
  /** Code point length of this player's current spell, or 0 before the book is public. */
  spellLength: number;
  /** This player's private, monotonic, zero-based spell cursor into the shared book. */
  spellIndex: number;
  /** Spells this player has completed during the match. */
  spellsCast: number;
  hp: number;
  maxHp: number;
  /** Total damage this player has applied to opponents: `DAMAGE_PER_CHARACTER * code points`. */
  damageDealt: number;
  /**
   * Confirmed correct characters from spells this player completed, monotone across the match. The
   * current accepted prefix is NOT part of this count (it is added for CPM while the spell is open).
   */
  correctChars: number;
  /** Server time of elimination, or `null` while alive. */
  eliminatedAt: number | null;
  /**
   * (`correctChars` + the current accepted prefix) per active minute; active time starts when combat
   * starts and stops at this player's elimination or the match end, never counting lobby/generation/countdown.
   */
  cpm: number;
  /** `null` when the player has no counted keystrokes yet. */
  accuracy: number | null;
  /** Competition rank after the match; `null` while the match is live. */
  rank: number | null;
}

/**
 * One completed spell's damage, published to every seat so all clients can render the same hit
 * without recomputing rules. The completed spell's text is never part of an event.
 */
export interface CombatEvent {
  /** Monotonic per match, starting at 1; `(matchId, seq)` is what clients dedupe on. */
  seq: number;
  at: number;
  attackerId: string;
  targetId: string;
  element: Element;
  damage: number;
  /** Target's remaining HP after this hit. */
  targetHp: number;
  /** The attacker's spell index that produced this hit. */
  spellIndex: number;
  /** True when this hit brought the target to 0 HP. */
  eliminated: boolean;
}

/**
 * Authoritative room state. `selfInput` and the `spell` field are recipient-scoped: the room only
 * sends a player's own current spell and their own accepted draft, never the book or a rival's draft.
 */
export interface RoomSnapshot {
  id: string;
  matchId: string | null;
  hostId: string;
  mode: RoomMode;
  theme: string;
  difficulty: Difficulty;
  phase: Phase;
  /** Opening countdown end, then the single combat end. `0` in phases with no clock. */
  deadline: number;
  serverNow: number;
  /** When the combat phase began, or `null` before it did. */
  startedAt: number | null;
  /** When the match settled, or `null` while it is live. */
  endedAt: number | null;
  endReason: EndReason | null;
  spell: Spell | null;
  selfInput: string;
  /** Bounded recent damage ring, oldest first; empty before the first hit. */
  events: CombatEvent[];
  persistence: Persistence;
  reservationExpiresAt: number | null;
  players: Player[];
  error: string | null;
}

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerMessage =
  | { type: 'state'; room: RoomSnapshot }
  | { type: 'error'; message: string }
  | { type: 'pong'; serverNow: number };

export type RoomInit = z.infer<typeof roomInitSchema>;

export interface MatchTicket {
  state: 'waiting' | 'matched';
  difficulty: Difficulty;
  /** Present only when `state` is `matched`. */
  roomId?: string;
  /** For `waiting`: the entry expiry (refreshed by polling). For `matched`: the seat reservation expiry. */
  expiresAt: number;
}

export interface MatchCancelResult {
  /**
   * `true` once this account holds no matchmaking ticket and no live pre-match reservation
   * (idempotent: also `true` when there was nothing to cancel).
   * `false` when a started match still holds this account's seat.
   */
  cancelled: boolean;
}

/**
 * One persisted match row for one account, as returned by `GET /api/profile`.
 */
export interface MatchResult {
  match_id: string;
  theme: string;
  damage_dealt: number;
  /** Health left when the match settled; `0` when this account was eliminated. */
  hp_remaining: number;
  spells_cast: number;
  correct_chars: number;
  /** Active combat time only; `0` on a match that ended before combat began. */
  duration_ms: number;
  rank: number;
  cpm: number;
  /** `null` when the account produced no counted keystroke; that state is unknown, not 0% or 100%. */
  accuracy: number | null;
  created_at: number;
}

export interface Profile {
  user: User;
  stats: { games: number; wins: number; bestCpm: number };
  history: MatchResult[];
}

/** `GET /api/session` — never exposes secrets or provider error details. */
export interface SessionInfo {
  user: User | null;
  aiConfigured: boolean;
}

/**
 * Close codes the room may send. Shared so the client, the room and the router cannot drift:
 * `replaced`/`closed`/`sessionExpired` are terminal (stop reconnecting), `restart` is recoverable
 * (re-check the session and the room over HTTP, then retry).
 */
export const WS_CLOSE = {
  /** Another connection took over this account's seat in the room. */
  replaced: 4000,
  /** The room ended this reservation or match; there is nothing left to reconnect to. */
  closed: 4001,
  /** The session expired or was revoked: re-authenticate before retrying. */
  sessionExpired: 4002,
} as const;

export type WsCloseCode = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];

/** Recoverable restart hint; a rejected handshake (401/404/409) reaches the client as 1006 instead. */
export const WS_CLOSE_RESTART = 1012;
