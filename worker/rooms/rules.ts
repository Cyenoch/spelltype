import { MAX_MESSAGE_BYTES } from '../../shared/protocol';
import type { Phase } from '../../shared/protocol';
import type { RoomRow } from './storage/schema';

/** A never-connected/disconnected lobby seat is reclaimable this long after it went idle. */
export const SEAT_TTL_MS = 120_000;
/** A private match needs two connected players willing to start. */
export const MIN_PLAYERS = 2;
/** One alarm performs at most this many due transitions, so a long outage cannot loop forever. */
export const MAX_CATCHUP_STEPS = 32;
/** A JS string this many UTF-16 units long is always <= MAX_MESSAGE_BYTES UTF-8 bytes. */
export const MESSAGE_LENGTH_FAST_PATH = Math.floor(MAX_MESSAGE_BYTES / 3);
/** Coalesced snapshots from a human typist stay far below this. */
export const INPUTS_PER_SECOND = 60;

/** Phases whose `deadline` is an authoritative clock: the opening countdown, then the single combat end. */
export const TIMED_PHASES: Record<Phase, boolean> = {
  lobby: false,
  generating: false,
  countdown: true,
  playing: true,
  finished: false,
};

/** Phases in which a running match owns the seats and a reservation must not be released. */
export const MATCH_ACTIVE: Record<Phase, boolean> = {
  lobby: false,
  generating: true,
  countdown: true,
  playing: true,
  finished: false,
};

/** Phases in which the generated book is public, so a seat can see its own current spell. */
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
 * the alarm has not caught up with yet are all excluded — the clock decides, never the alarm.
 */
export function duelIsOngoing(room: RoomRow, now: number): boolean {
  return room.phase === 'playing' && room.deadline > now;
}

/**
 * A quick reservation is live only until its deadline: the clock decides, so a
 * delayed alarm can never let a late player join or start on a dead ticket.
 */
export function reservationIsLive(room: RoomRow, now: number): boolean {
  return (
    room.reservation_state === 'reserved' &&
    room.reservation_expires_at !== null &&
    room.reservation_expires_at > now
  );
}

/** True once a quick room offers no seat any more, whether it was cancelled or its deadline passed. */
export function reservationIsGone(room: RoomRow, now: number): boolean {
  if (room.mode !== 'quick') return false;
  if (room.reservation_state === 'cancelled' || room.reservation_state === 'expired') return true;
  return room.reservation_state === 'reserved' && !reservationIsLive(room, now);
}
