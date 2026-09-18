import { MAX_MESSAGE_BYTES } from '../../shared/protocol';
import type { Phase } from '../../shared/protocol';
import type { RoomRow } from '../db/schema';

/** A never-connected/disconnected lobby seat is reclaimable this long after it went idle. */
export const SEAT_TTL_MS = 120_000;
/** A private match needs two connected players willing to start. */
export const MIN_PLAYERS = 2;
/** One catch-up pass performs at most this many due transitions, so a long outage cannot loop forever. */
export const MAX_CATCHUP_STEPS = 32;
/** A JS string this many UTF-16 units long is always <= MAX_MESSAGE_BYTES UTF-8 bytes. */
export const MESSAGE_LENGTH_FAST_PATH = Math.floor(MAX_MESSAGE_BYTES / 3);
/** Coalesced snapshots from a human typist stay far below this. */
export const INPUTS_PER_SECOND = 60;

/**
 * The input-time policy every measured match is stamped with. Raising or lowering the floor below
 * is a new version, never a silent rewrite: the version is frozen onto the room row, the result
 * rows and every snapshot for the life of the match.
 */
export const INPUT_POLICY_VERSION = 'ascii-floor-v1';
/** Real milliseconds one target code point costs before that spell's completion may count. */
export const INPUT_MIN_MS_PER_CODE_POINT = 35;

/** Phases whose `deadline` is an authoritative clock: the opening countdown, then the single combat end. */
export const TIMED_PHASES: Record<Phase, boolean> = {
  lobby: false,
  generating: false,
  countdown: true,
  playing: true,
  finished: false,
};

/** Phases in which a match is being formed or fought: generation, the opening countdown and combat. */
export const MATCH_ACTIVE: Record<Phase, boolean> = {
  lobby: false,
  generating: true,
  countdown: true,
  playing: true,
  finished: false,
};

/** Phases in which the shared spell book is published to every seat. */
export const BOOK_PHASES: Record<Phase, boolean> = {
  lobby: false,
  generating: false,
  countdown: true,
  playing: true,
  finished: true,
};

/**
 * True while this room is a duel a spectator could watch right now: the combat phase is live and
 * its single deadline has not passed. Lobby, generation, countdown, a settled match and a deadline
 * the runtime has not caught up with yet are all excluded — the clock decides, never the timer.
 */
export function duelIsOngoing(room: RoomRow, now: number): boolean {
  return room.phase === 'playing' && room.deadline > now;
}

/**
 * A quick reservation is live only until its deadline: the clock decides, so a
 * delayed catch-up can never let a late player join or start on a dead ticket.
 */
export function reservationIsLive(room: RoomRow, now: number): boolean {
  return (
    room.mode === 'quick' &&
    room.reservation_state === 'reserved' &&
    room.reservation_expires_at !== null &&
    now < room.reservation_expires_at
  );
}

/**
 * True once a quick pairing can no longer be joined at all: cancelled, expired
 * by its own clock, or consumed by a match. A stale locator must read the same
 * refusal the room's own handshake would give.
 */
export function reservationIsGone(room: RoomRow, now: number): boolean {
  return (
    room.mode === 'quick' &&
    (room.reservation_state === 'cancelled' ||
      room.reservation_state === 'expired' ||
      (room.reservation_state === 'reserved' && !reservationIsLive(room, now)))
  );
}
