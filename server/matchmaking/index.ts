import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, ne } from 'drizzle-orm';
import type { Phase } from '../../shared/protocol';
import { QUEUE_ENTRY_TTL_MS, RESERVATION_TTL_MS, THEME_PRESETS } from '../../shared/protocol';
import type { MatchCancelResult, MatchTicket, User } from '../../shared/protocol';
import { ReleaseError } from '../../shared/release';
import type { Database, QueryDatabase, Transaction } from '../db';
import {
  departures,
  matchTickets,
  players,
  releaseControl,
  releaseVersions,
  rooms,
  type RoomRow,
  type TicketRow,
} from '../db/schema';
import { createRoom } from '../rooms/storage/room';

/**
 * Matchmaking against one shared database.
 *
 * The `match_tickets.user_id` primary key enforces one global seat per account. Waiting rows form
 * per-release queues; matched rows identify reserved or playing seats. Pairing commits the room,
 * both players and both tickets in one transaction.
 *
 * Truthfulness rules:
 * - `cancelled: true` only once the account provably holds no ticket and no live seat. A started
 *   match keeps its seat and answers `false`; cancelling one side of a reserved pairing frees
 *   *both* seats and both tickets so the surviving account can queue again immediately.
 * - A matched ticket follows its room, not the clock: it stays while the reservation is live or a
 *   match is running (and this account has not departed), and is deleted the moment its seat is
 *   provably gone. A waiting ticket is TTL-refreshed by polling and nothing else.
 * - Cross-release: a poll served by a non-active release never mints a ticket. It truthfully
 *   removes waiting entries (`release:update_required`) while preserving a still-live matched seat
 *   so the client can enter the room it already owns on the old release.
 * - Admission: every transaction that creates or consumes queue state first share-locks the
 *   control row and verifies the pointer, and pairing additionally re-verifies it before writing
 *   the room — so no pairing for a release that has lost the pointer can exist, not even for one
 *   transaction. (`withAdmission` in `server/releases/control.ts` is the room-creation gate.)
 * - Lock order: control → release → room → tickets, tickets in `user_id`
 *   order whenever a transaction takes more than one. No network waits inside any transaction here.
 */

/** Phases in which a running match owns the seats and a reservation must not be released. */
const MATCH_ACTIVE: Record<Phase, boolean> = {
  lobby: false,
  generating: true,
  countdown: true,
  playing: true,
  finished: false,
};

/** Bounded re-reads: each pass follows a decision a concurrent request may have changed first. */
const PASSES = 3;

/** A poll arrived for a request that no longer exists: the account was cancelled underneath it. */
export class MatchRejection extends Error {
  readonly status = 409;
  readonly userMessage: string;
  readonly error: string;

  constructor() {
    super('匹配已取消，请重新发起匹配');
    this.name = 'MatchRejection';
    this.userMessage = this.error = '匹配已取消，请重新发起匹配';
  }
}

export type MatchCancelOutcome = MatchCancelResult & {
  /** The room whose reservation this cancellation freed; the caller refreshes its runtime. */
  roomId: string | null;
};

/** Room identity: 24 lowercase hex characters, generated with a secure RNG. */
export function newRoomId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 24);
}

/**
 * One matchmaking poll: join (or stay) in the queue, refresh a waiting entry's TTL, answer with an
 * existing matched seat, or pair with the oldest other waiting account of the same release. The
 * release is the caller's own compiled identity — the HTTP layer has already checked the client's
 * version against it; this module checks both against the admission pointer.
 */
export async function acquireMatch(
  database: Database,
  releaseId: string,
  user: User,
): Promise<MatchTicket> {
  for (let pass = 0; pass < PASSES; pass += 1) {
    const step = await refreshOrJoin(database, releaseId, user);
    if (step === 'retry') continue;
    // Thrown only after the step's transaction has committed, so a truthful removal of a dead
    // ticket is never rolled back together with the refusal.
    if ('refusal' in step) throw new ReleaseError('release:update_required', step.activeReleaseId);
    if (step.pair) {
      const paired = await attemptPairing(database, releaseId, user);
      if (paired) return paired;
    }
    return step.ticket;
  }
  // Every pass saw the row move under it: answer with whatever stands now, never mint a request.
  const current = await readTicket(database, user.id);
  if (!current) throw new MatchRejection();
  if (current.state === 'matched') {
    return {
      releaseId: current.release_id,
      state: 'matched',
      roomId: current.room_id ?? undefined,
      expiresAt: current.expires_at,
    };
  }
  return { releaseId: current.release_id, state: 'waiting', expiresAt: current.expires_at };
}

/**
 * Cancels this account's matchmaking. The outcome is the contract the HTTP layer forwards: it is
 * `cancelled: false` only when a started match provably still holds the seat, and carries the
 * `roomId` of a reservation it freed so the caller can refresh that room's runtime.
 */
export async function cancelMatch(database: Database, userId: string): Promise<MatchCancelOutcome> {
  for (let pass = 0; pass < PASSES; pass += 1) {
    const outcome = await database.transaction(
      async (tx): Promise<MatchCancelOutcome | 'retry'> => {
        const peek = await readTicket(tx, userId);
        if (!peek) return { cancelled: true, roomId: null };
        if (peek.state === 'waiting') {
          const current = await lockTicket(tx, userId);
          if (!current) return { cancelled: true, roomId: null };
          if (current.state !== 'waiting') return 'retry';
          await tx.delete(matchTickets).where(eq(matchTickets.user_id, userId));
          return { cancelled: true, roomId: null };
        }

        const roomId = peek.room_id;
        if (!roomId) {
          // A matched row without a room can hold no seat: corrupt state is freed, not preserved.
          const current = await lockTicket(tx, userId);
          if (!current || current.state !== 'matched') return 'retry';
          await tx.delete(matchTickets).where(eq(matchTickets.user_id, userId));
          return { cancelled: true, roomId: null };
        }
        const room = await lockRoom(tx, roomId);
        const current = await lockTicket(tx, userId);
        if (!current || current.state !== 'matched' || current.room_id !== roomId) return 'retry';
        if (!room) {
          await tx.delete(matchTickets).where(eq(matchTickets.user_id, userId));
          return { cancelled: true, roomId: null };
        }

        if (MATCH_ACTIVE[room.phase]) {
          const freed = await seatReleasedByDeparture(tx, room, userId);
          if (!freed) return { cancelled: false, roomId };
          await tx.delete(matchTickets).where(eq(matchTickets.user_id, userId));
          return { cancelled: true, roomId: null };
        }
        if (room.mode !== 'quick' || room.reservation_state !== 'reserved') {
          // The reservation is already gone (cancelled, expired) or this room never had one.
          await tx.delete(matchTickets).where(eq(matchTickets.user_id, userId));
          return { cancelled: true, roomId: null };
        }
        await cancelReservedPairing(tx, room, Date.now());
        return { cancelled: true, roomId };
      },
    );
    if (outcome !== 'retry') return outcome;
  }
  // Passes exhausted: one final conservative transaction. A still-waiting entry is deleted for
  // real; a matched row is answered without mutation — `cancelled: false` stays the honest
  // answer whenever a match may still own the seat.
  return database.transaction(async (tx): Promise<MatchCancelOutcome> => {
    const current = await lockTicket(tx, userId);
    if (!current) return { cancelled: true, roomId: null };
    if (current.state === 'waiting') {
      await tx.delete(matchTickets).where(eq(matchTickets.user_id, userId));
      return { cancelled: true, roomId: null };
    }
    return { cancelled: false, roomId: current.room_id ?? null };
  });
}

// ----------------------------------------------------------------- ticket refresh / join

/**
 * Acquires the ticket FK's parent lock (`match_tickets.release_id` → `release_versions`) before
 * any room or ticket lock is taken. Without it a poll that touches a room first and then inserts
 * or updates tickets would acquire the release row's KEY SHARE *after* the room lock, while the
 * room engine's `assert` takes release → room: the two orders would deadlock. Taking release
 * before rooms in every transaction is what makes the shared order hold.
 */
async function lockReleaseKeyShare(tx: QueryDatabase, releaseId: string): Promise<void> {
  await tx
    .select({ id: releaseVersions.id })
    .from(releaseVersions)
    .where(eq(releaseVersions.id, releaseId))
    .for('key share');
}

/**
 * One committed step of a poll. The refusal variant is returned — never thrown — so the removal
 * of a dead or barred ticket commits before `acquireMatch` refuses the poll.
 */
type AcquireStep =
  | { ticket: MatchTicket; pair: boolean }
  | { refusal: 'update_required'; activeReleaseId: string | null }
  | 'retry';

const barred = (activeReleaseId: string | null): AcquireStep => ({
  refusal: 'update_required',
  activeReleaseId,
});

async function refreshOrJoin(
  database: Database,
  releaseId: string,
  user: User,
): Promise<AcquireStep> {
  return database.transaction(async (tx): Promise<AcquireStep> => {
    const active = await lockActiveRelease(tx);
    const admissionOpen = active === releaseId;
    await lockReleaseKeyShare(tx, releaseId);
    const now = Date.now();
    const peek = await readTicket(tx, user.id);

    if (peek?.state === 'matched') {
      const roomId = peek.room_id;
      if (!roomId) {
        const current = await lockTicket(tx, user.id);
        if (!current || current.state !== 'matched') return 'retry';
        await tx.delete(matchTickets).where(eq(matchTickets.user_id, user.id));
      } else {
        const room = await lockRoom(tx, roomId);
        const current = await lockTicket(tx, user.id);
        if (!current || current.state !== 'matched' || current.room_id !== roomId) return 'retry';
        if (!room || !(await seatHeld(tx, room, user.id))) {
          await tx.delete(matchTickets).where(eq(matchTickets.user_id, user.id));
        } else {
          // The room owns a live seat; polling must not extend its published reservation deadline.
          return {
            ticket: {
              releaseId: current.release_id,
              state: 'matched',
              roomId,
              expiresAt: current.expires_at,
            },
            pair: false,
          };
        }
      }
      // The seat is provably gone. Without admission there is no honest successor, so the poll
      // refuses instead of inventing a new entry for a release that no longer admits.
      if (!admissionOpen) return barred(active);
      return insertWaiting(tx, releaseId, user, now);
    }

    if (peek?.state === 'waiting') {
      const current = await lockTicket(tx, user.id);
      if (!current) return 'retry';
      if (current.state !== 'waiting') return 'retry';
      if (current.release_id !== releaseId) {
        // The account's entry belongs to another release. A barred poll leaves it untouched —
        // it may be the successor release's valid entry. A poll for the active release can
        // never pair with a foreign entry (pairing is release-scoped), so the stale entry is
        // released and this poll enqueues fresh for its own release.
        if (!admissionOpen) return barred(active);
        await tx.delete(matchTickets).where(eq(matchTickets.user_id, user.id));
        return insertWaiting(tx, releaseId, user, now);
      }
      if (!admissionOpen) {
        // Truthful removal: the old release's entry stops existing rather than expiring silently.
        await tx.delete(matchTickets).where(eq(matchTickets.user_id, user.id));
        return barred(active);
      }
      const expiresAt = now + QUEUE_ENTRY_TTL_MS;
      await tx
        .update(matchTickets)
        .set({ username: user.username, expires_at: expiresAt, updated_at: now })
        .where(eq(matchTickets.user_id, user.id));
      return { ticket: { releaseId, state: 'waiting', expiresAt }, pair: true };
    }

    if (!admissionOpen) return barred(active);
    return insertWaiting(tx, releaseId, user, now);
  });
}

async function insertWaiting(
  tx: Transaction,
  releaseId: string,
  user: User,
  now: number,
): Promise<AcquireStep> {
  const requestId = randomUUID();
  const expiresAt = now + QUEUE_ENTRY_TTL_MS;
  // The primary key is the occupancy check, and the insert never overwrites: a concurrent poll of
  // this account may have created a ticket (or won a seat) between this transaction's snapshot
  // and its insert, and that row — not this request — owns the answer.
  const [inserted] = await tx
    .insert(matchTickets)
    .values({
      user_id: user.id,
      request_id: requestId,
      release_id: releaseId,
      username: user.username,
      state: 'waiting',
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { ticket: { releaseId, state: 'waiting', expiresAt }, pair: true };

  const existing = await lockTicket(tx, user.id);
  if (!existing) return 'retry';
  if (existing.state === 'matched') {
    return {
      ticket: {
        releaseId: existing.release_id,
        state: 'matched',
        roomId: existing.room_id ?? undefined,
        expiresAt: existing.expires_at,
      },
      pair: false,
    };
  }
  const expires = Math.max(existing.expires_at, now + QUEUE_ENTRY_TTL_MS);
  await tx
    .update(matchTickets)
    .set({ username: user.username, expires_at: expires, updated_at: now })
    .where(eq(matchTickets.user_id, user.id));
  return {
    ticket: { releaseId: existing.release_id, state: 'waiting', expiresAt: expires },
    pair: true,
  };
}

// ----------------------------------------------------------------------------- pairing

async function attemptPairing(
  database: Database,
  releaseId: string,
  user: User,
): Promise<MatchTicket | null> {
  return database.transaction(async (tx) => {
    const active = await lockActiveRelease(tx);
    if (active !== releaseId) return null; // the barrier closed between the two polls: stay waiting
    await lockReleaseKeyShare(tx, releaseId);
    const now = Date.now();

    const mine = await readTicket(tx, user.id);
    if (!mine || mine.state !== 'waiting' || mine.expires_at <= now) return null;
    const [partner] = await tx
      .select()
      .from(matchTickets)
      .where(
        and(
          ne(matchTickets.user_id, user.id),
          eq(matchTickets.state, 'waiting'),
          eq(matchTickets.release_id, releaseId),
          gt(matchTickets.expires_at, now),
        ),
      )
      .orderBy(asc(matchTickets.created_at), asc(matchTickets.user_id))
      .limit(1);
    if (!partner) return null;

    // Both rows, oldest account first: the shared total order is what keeps two simultaneous
    // polls from deadlocking on each other's ticket.
    const ordered = [user.id, partner.user_id].sort();
    let partnerRow: TicketRow | null = null;
    for (const id of ordered) {
      const row = await lockTicket(tx, id);
      if (id === user.id) {
        if (!row || row.state !== 'waiting' || row.expires_at <= now) return null;
      } else {
        if (!row || row.state !== 'waiting' || row.expires_at <= now) return null;
        partnerRow = row;
      }
    }
    if (!partnerRow) return null;

    const roomId = newRoomId();
    const expiresAt = now + RESERVATION_TTL_MS;
    // Room, both reserved seats and both tickets: one transaction or nothing. `createRoom` sets
    // the room's own reservation clock; the tickets mirror its TTL so clients see one deadline.
    await createRoom(tx, {
      id: roomId,
      releaseId,
      host: { id: user.id, username: user.username },
      theme: THEME_PRESETS[Math.floor(Math.random() * THEME_PRESETS.length)].theme,
      mode: 'quick',
      reserved: [{ id: partnerRow.user_id, username: partnerRow.username }],
    });
    await tx
      .update(matchTickets)
      .set({ state: 'matched', room_id: roomId, expires_at: expiresAt, updated_at: now })
      .where(inArray(matchTickets.user_id, [user.id, partnerRow.user_id]));
    return { releaseId, state: 'matched', roomId, expiresAt };
  });
}

// ------------------------------------------------------------------ seat verdicts & shared locks

/**
 * Whether the room still holds this account's seat. Active phases hold it until the account
 * explicitly departs from the running match (`departures` row naming the current match); a settled
 * match and a dead reservation hold nothing.
 */
async function seatHeld(tx: QueryDatabase, room: RoomRow, userId: string): Promise<boolean> {
  if (MATCH_ACTIVE[room.phase]) return !(await seatReleasedByDeparture(tx, room, userId));
  if (room.phase !== 'lobby') return false;
  if (room.mode !== 'quick' || room.reservation_state !== 'reserved') return false;
  return room.reservation_expires_at !== null && room.reservation_expires_at > Date.now();
}

/** True when this account explicitly gave up its seat in the match the room is running. */
async function seatReleasedByDeparture(
  tx: QueryDatabase,
  room: RoomRow,
  userId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ match_id: departures.match_id })
    .from(departures)
    .where(and(eq(departures.room_id, room.id), eq(departures.user_id, userId)))
    .limit(1);
  return row !== undefined && row.match_id === room.match_id;
}

/**
 * Tears down a live (or just-lapsed) quick reservation from the matchmaking side: the room records
 * why, both reserved seats disappear, and both accounts' matched tickets are freed so the other
 * account's next poll re-queues instead of chasing a dead room. The room row itself survives so
 * the runtime can still show what happened to anyone already looking at it.
 */
async function cancelReservedPairing(tx: Transaction, room: RoomRow, now: number): Promise<void> {
  const live = room.reservation_expires_at !== null && room.reservation_expires_at > now;
  await tx
    .update(rooms)
    .set({
      reservation_state: live ? 'cancelled' : 'expired',
      reservation_expires_at: null,
      error: live ? '匹配已取消，请重新匹配。' : '匹配超时，请重新匹配。',
      updated_at: now,
    })
    .where(eq(rooms.id, room.id));
  await tx.delete(players).where(eq(players.room_id, room.id));
  await tx
    .delete(matchTickets)
    .where(and(eq(matchTickets.room_id, room.id), eq(matchTickets.state, 'matched')));
}

async function lockActiveRelease(tx: QueryDatabase): Promise<string | null> {
  const [control] = await tx
    .select({ active_release_id: releaseControl.active_release_id })
    .from(releaseControl)
    .limit(1)
    .for('share');
  return control?.active_release_id ?? null;
}

async function readTicket(executor: QueryDatabase, userId: string): Promise<TicketRow | null> {
  const [row] = await executor
    .select()
    .from(matchTickets)
    .where(eq(matchTickets.user_id, userId))
    .limit(1);
  return row ?? null;
}

async function lockTicket(executor: QueryDatabase, userId: string): Promise<TicketRow | null> {
  const [row] = await executor
    .select()
    .from(matchTickets)
    .where(eq(matchTickets.user_id, userId))
    .for('update');
  return row ?? null;
}

async function lockRoom(executor: QueryDatabase, roomId: string): Promise<RoomRow | null> {
  const [row] = await executor.select().from(rooms).where(eq(rooms.id, roomId)).for('update');
  return row ?? null;
}
