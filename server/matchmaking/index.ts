import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, ne } from 'drizzle-orm';
import type { Phase } from '../../shared/protocol';
import {
  QUEUE_ENTRY_TTL_MS,
  QUICK_GHOST_FALLBACK_MS,
  RESERVATION_TTL_MS,
  THEME_PRESETS,
} from '../../shared/protocol';
import type { MatchCancelResult, MatchTicket, User } from '../../shared/protocol';
import { assertAdmission } from '../maintenance/control';
import type { Database, QueryDatabase, Transaction } from '../db';
import {
  departures,
  matchTickets,
  players,
  rooms,
  type RoomRow,
  type TicketRow,
} from '../db/schema';
import { chooseGhost } from '../ghosts';
import { createRoom, updateRoom } from '../rooms/storage/room';

/**
 * Matchmaking against one shared database.
 *
 * The `match_tickets.user_id` primary key enforces one global seat per account. Waiting rows form
 * the one shared queue; matched rows identify reserved or playing seats. Pairing commits the room,
 * both players and both tickets in one transaction.
 *
 * Truthfulness rules:
 * - `cancelled: true` only once the account provably holds no ticket and no live seat. A started
 *   match keeps its seat and answers `false`; cancelling one side of a reserved pairing frees
 *   *both* seats and both tickets so the surviving account can queue again immediately.
 * - A matched ticket follows its room, not the clock: it stays while the reservation is live or a
 *   match is running (and this account has not departed), and is deleted the moment its seat is
 *   provably gone. A waiting ticket is TTL-refreshed by polling and nothing else.
 * - Maintenance: a matched seat stays readable (and playable) while the server drains; cancelling
 *   works too. New queue entries and new pairings read durable admission from `runtime_control`
 *   inside their own transaction — `assertAdmission` share-locks the control row first, so no
 *   waiting ticket or paired room can commit after the drain began. The removal of a dead seat's
 *   ticket commits in its own admission-free transaction, so a refusal can never roll it back.
 * - Synthetic fallback: a lone waiter whose queue entry has waited `QUICK_GHOST_FALLBACK_MS`
 *   since it (re)entered the queue is matched with a synthetic partner — but only after the
 *   real-partner attempt, and never while another live waiting ticket exists for the next poll
 *   to pair. A qualifying replayed ghost is preferred; with none, the opponent is a generated
 *   bot. Either way one transaction creates the room, seats the synthetic opponent
 *   (`synthetic:<roomId>`, displayed as `Ghost / 训练法师`) seated and ready from birth with no
 *   slot clock, and consumes only the human's ticket, which becomes the room's matched seat. The
 *   synthetic side holds no account, session or ticket, so the one-seat-per-account invariant
 *   and every fence above stay intact. A queue entry's `created_at` is its arrival: TTL
 *   refreshes never move it, and refreshing an already-lapsed entry arrives fresh, so a
 *   resurrected ticket cannot skip the real-partner window.
 * - Lock order: runtime_control first (the ownership fence, then admission) → room → tickets,
 *   tickets in `user_id` order whenever a transaction takes more than one. No network waits inside
 *   any transaction here.
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

/** The synthetic opponent's display name. It never maps to an account, a session or a ticket. */
const SYNTHETIC_OPPONENT_NAME = 'Ghost / 训练法师';

/** The synthetic seat's id, derived from its room so it is unique without an account behind it. */
const syntheticSeatId = (roomId: string): string => `synthetic:${roomId}`;

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
 * One matchmaking poll: answer with an existing matched seat, join (or stay in) the shared queue,
 * refresh a waiting entry's TTL, pair with the oldest other waiting account, or — once the entry
 * has waited out the fallback deadline with no live partner — assign it a synthetic opponent
 * (a replayed ghost when one qualifies, else a generated bot). Admission to the queue is
 * durable: the refusing and admitting reads happen inside the transaction that creates or
 * extends queue state, so a poll can never mint an entry the drain already closed.
 *
 * `assertOwnership` is the runtime write fence (the lease holder's identity proof) and runs first
 * inside every mutating transaction here: a process that lost its lease must never write a ticket,
 * free a seat or pair a room after a successor took over.
 */
export async function acquireMatch(
  database: Database,
  user: User,
  assertOwnership: (tx: Transaction) => Promise<void>,
): Promise<MatchTicket> {
  // The matched seat is answered first, admission-free: it stays readable — and playable — while
  // the server drains. A dead seat's ticket is deleted and committed here, so the admission
  // refusal below can never roll that cleanup back.
  for (let pass = 0; pass < PASSES; pass += 1) {
    const standing = await inspectStanding(database, user, assertOwnership);
    if (standing === 'retry') continue;
    if (standing.kind === 'matched') return standing.ticket;
    break; // `gone` (cleanup committed) or `queue`: rejoining needs durable admission.
  }
  for (let pass = 0; pass < PASSES; pass += 1) {
    const step = await refreshWaiting(database, user, assertOwnership);
    if (step === 'retry') continue;
    if (step.pair) {
      const paired = await attemptPairing(database, user, assertOwnership);
      if (paired) return paired;
      // Nobody live to pair with: a lone waiter past the fallback deadline gets a ghost —
      // or, when no replay qualifies, a generated bot.
      const synthetic = await assignSyntheticPartner(database, user, assertOwnership);
      if (synthetic) return synthetic;
    }
    return step.ticket;
  }
  // Every pass saw the row move under it: answer with whatever stands now, never mint a request.
  const current = await readTicket(database, user.id);
  if (!current) throw new MatchRejection();
  if (current.state === 'matched') return matchedTicketOf(current);
  return { state: 'waiting', expiresAt: current.expires_at };
}

/**
 * Cancels this account's matchmaking. The outcome is the contract the HTTP layer forwards: it is
 * `cancelled: false` only when a started match provably still holds the seat, and carries the
 * `roomId` of a reservation it freed so the caller can refresh that room's runtime. Cancelling
 * consumes no admission: it works while the server drains.
 *
 * `assertOwnership` is required because cancelling mutates: it frees tickets and tears down a
 * reserved pairing's room row and seats. A process that lost its lease stops at the fence, before
 * any room or ticket lock, so a successor's state is never rewritten underneath it.
 */
export async function cancelMatch(
  database: Database,
  userId: string,
  assertOwnership: (tx: Transaction) => Promise<void>,
): Promise<MatchCancelOutcome> {
  for (let pass = 0; pass < PASSES; pass += 1) {
    const outcome = await database.transaction(
      async (tx): Promise<MatchCancelOutcome | 'retry'> => {
        await assertOwnership(tx);
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
    await assertOwnership(tx);
    const current = await lockTicket(tx, userId);
    if (!current) return { cancelled: true, roomId: null };
    if (current.state === 'waiting') {
      await tx.delete(matchTickets).where(eq(matchTickets.user_id, userId));
      return { cancelled: true, roomId: null };
    }
    return { cancelled: false, roomId: current.room_id ?? null };
  });
}

// ------------------------------------------------------------- matched-seat standing

/** What the admission-free first transaction learned about this account's matched seat. */
type Standing =
  | { kind: 'matched'; ticket: MatchTicket }
  | { kind: 'gone' }
  | { kind: 'queue' }
  | 'retry';

/**
 * Reads the account's matched seat without touching admission, and frees a provably dead one.
 * Committing the cleanup here — separate from the admission-gated rejoin below — is what keeps a
 * maintenance refusal from resurrecting a dead seat's ticket. The write fence runs first: freeing
 * a dead seat's ticket is a mutation like any other, and a stand-down owner performs none.
 */
async function inspectStanding(
  database: Database,
  user: User,
  assertOwnership: (tx: Transaction) => Promise<void>,
): Promise<Standing> {
  return database.transaction(async (tx): Promise<Standing> => {
    await assertOwnership(tx);
    const peek = await readTicket(tx, user.id);
    if (!peek) return { kind: 'queue' };
    if (peek.state !== 'matched') return { kind: 'queue' };

    const roomId = peek.room_id;
    if (!roomId) {
      // A matched row without a room can hold no seat: corrupt state is freed, not preserved.
      const current = await lockTicket(tx, user.id);
      if (!current || current.state !== 'matched') return 'retry';
      await tx.delete(matchTickets).where(eq(matchTickets.user_id, user.id));
      return { kind: 'gone' };
    }
    const room = await lockRoom(tx, roomId);
    const current = await lockTicket(tx, user.id);
    if (!current || current.state !== 'matched' || current.room_id !== roomId) return 'retry';
    if (!room || !(await seatHeld(tx, room, user.id))) {
      await tx.delete(matchTickets).where(eq(matchTickets.user_id, user.id));
      return { kind: 'gone' };
    }
    return { kind: 'matched', ticket: matchedTicketOf(current) };
  });
}

function matchedTicketOf(row: TicketRow): MatchTicket {
  return {
    state: 'matched',
    roomId: row.room_id ?? undefined,
    expiresAt: row.expires_at,
  };
}

// ------------------------------------------------------------------------- queue join / refresh

/**
 * One admission-gated queue step: refreshes a waiting entry's TTL or mints a new one. The write
 * fence and the admission read are the first two statements of the transaction, in that order;
 * nothing durable precedes them, so a draining refusal rolls back nothing — the dead-seat cleanup,
 * if any, already committed in `inspectStanding`.
 */
type JoinStep = { ticket: MatchTicket; pair: boolean } | 'retry';

async function refreshWaiting(
  database: Database,
  user: User,
  assertOwnership: (tx: Transaction) => Promise<void>,
): Promise<JoinStep> {
  return database.transaction(async (tx): Promise<JoinStep> => {
    await assertOwnership(tx);
    await assertAdmission(tx);
    const now = Date.now();
    const peek = await readTicket(tx, user.id);

    if (peek?.state === 'matched') {
      // A concurrent poll of this account won a seat between the two transactions: answer with it.
      const roomId = peek.room_id;
      if (!roomId) {
        const current = await lockTicket(tx, user.id);
        if (!current || current.state !== 'matched') return 'retry';
        await tx.delete(matchTickets).where(eq(matchTickets.user_id, user.id));
        return insertWaiting(tx, user, now);
      }
      const room = await lockRoom(tx, roomId);
      const current = await lockTicket(tx, user.id);
      if (!current || current.state !== 'matched' || current.room_id !== roomId) return 'retry';
      if (room && (await seatHeld(tx, room, user.id))) {
        return { ticket: matchedTicketOf(current), pair: false };
      }
      // The seat died inside the window; admission above is still the live answer for a rejoin.
      await tx.delete(matchTickets).where(eq(matchTickets.user_id, user.id));
      return insertWaiting(tx, user, now);
    }

    if (peek?.state === 'waiting') {
      const current = await lockTicket(tx, user.id);
      if (!current) return 'retry';
      if (current.state !== 'waiting') return 'retry';
      const expiresAt = now + QUEUE_ENTRY_TTL_MS;
      await tx
        .update(matchTickets)
        .set({
          username: user.username,
          expires_at: expiresAt,
          // A live entry keeps its arrival: repeated polls must not reset the waited duration the
          // ghost deadline measures. A lapsed entry left the queue, so its refresh is a fresh
          // arrival — a resurrected ticket cannot inherit the old wait and skip the real-partner
          // window.
          created_at: current.expires_at <= now ? now : current.created_at,
          updated_at: now,
        })
        .where(eq(matchTickets.user_id, user.id));
      return { ticket: { state: 'waiting', expiresAt }, pair: true };
    }

    return insertWaiting(tx, user, now);
  });
}

async function insertWaiting(tx: Transaction, user: User, now: number): Promise<JoinStep> {
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
      username: user.username,
      state: 'waiting',
      expires_at: expiresAt,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { ticket: { state: 'waiting', expiresAt }, pair: true };

  const existing = await lockTicket(tx, user.id);
  if (!existing) return 'retry';
  if (existing.state === 'matched') {
    return { ticket: matchedTicketOf(existing), pair: false };
  }
  const expires = Math.max(existing.expires_at, now + QUEUE_ENTRY_TTL_MS);
  await tx
    .update(matchTickets)
    .set({ username: user.username, expires_at: expires, updated_at: now })
    .where(eq(matchTickets.user_id, user.id));
  return { ticket: { state: 'waiting', expiresAt: expires }, pair: true };
}

// ----------------------------------------------------------------------------- pairing

async function attemptPairing(
  database: Database,
  user: User,
  assertOwnership: (tx: Transaction) => Promise<void>,
): Promise<MatchTicket | null> {
  return database.transaction(async (tx) => {
    // Fence first, admission second — both on runtime_control, before any room or ticket lock.
    // No pairing can be written by a stand-down owner, and no pairing can commit once the drain
    // began: a drain that begins mid-pairing waits for this transaction instead of racing it.
    await assertOwnership(tx);
    await assertAdmission(tx);
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
      host: { id: user.id, username: user.username },
      theme: THEME_PRESETS[Math.floor(Math.random() * THEME_PRESETS.length)].theme,
      mode: 'quick',
      reserved: [{ id: partnerRow.user_id, username: partnerRow.username }],
    });
    await tx
      .update(matchTickets)
      .set({ state: 'matched', room_id: roomId, expires_at: expiresAt, updated_at: now })
      .where(inArray(matchTickets.user_id, [user.id, partnerRow.user_id]));
    return { state: 'matched', roomId, expiresAt };
  });
}

// -------------------------------------------------------------------- synthetic fallback

/**
 * Assigns a synthetic partner to a lone waiter whose queue entry has waited at least
 * `QUICK_GHOST_FALLBACK_MS` — real partners are always tried first, so this runs only after
 * `attemptPairing` found nobody. A live waiting ticket seen here — a newcomer that queued
 * between the pairing attempt and this transaction — wins instead: the peek takes no lock, so
 * it cannot deadlock against pairing's user_id lock order, and the next poll pairs for real.
 * With no such partner, a qualifying replayed ghost is preferred; with none, the opponent
 * falls back to a generated bot. Either way one transaction creates the room, seats the
 * synthetic opponent (seated and ready from birth, `slot_expires_at` null: no connection or
 * session will ever arrive for it) and consumes only the caller's ticket, which becomes the
 * room's matched seat. The synthetic side holds no account row and no ticket, so the account
 * still occupies exactly one global seat. When the ticket moved under a concurrent poll's
 * match or a cancellation, nothing is written and the caller keeps its waiting answer.
 *
 * The fence and admission come first, exactly as in pairing: a stand-down owner allocates
 * nothing, and a drain that begins mid-assignment waits for this transaction instead of racing
 * it. The ticket is re-read under lock so the deadline decision is made against the row that
 * will be consumed, never against the earlier refresh's snapshot.
 */
async function assignSyntheticPartner(
  database: Database,
  user: User,
  assertOwnership: (tx: Transaction) => Promise<void>,
): Promise<MatchTicket | null> {
  return database.transaction(async (tx): Promise<MatchTicket | null> => {
    await assertOwnership(tx);
    await assertAdmission(tx);
    const now = Date.now();

    const mine = await lockTicket(tx, user.id);
    if (!mine) return null;
    // A concurrent poll won a seat between the refresh and this transaction: answer with it.
    if (mine.state === 'matched') return matchedTicketOf(mine);
    if (mine.state !== 'waiting' || mine.expires_at <= now) return null;
    if (now - mine.created_at < QUICK_GHOST_FALLBACK_MS) return null;

    // A newcomer between the pairing attempt and now must not be bypassed by a synthetic
    // partner: leave them for this poll's next pairing pass. Lock-free on purpose.
    const [newcomer] = await tx
      .select({ user_id: matchTickets.user_id })
      .from(matchTickets)
      .where(
        and(
          ne(matchTickets.user_id, user.id),
          eq(matchTickets.state, 'waiting'),
          gt(matchTickets.expires_at, now),
        ),
      )
      .limit(1);
    if (newcomer) return null;

    const ghost = await chooseGhost(tx, user.id);
    const theme = ghost
      ? ghost.theme
      : THEME_PRESETS[Math.floor(Math.random() * THEME_PRESETS.length)].theme;

    const roomId = newRoomId();
    const seatId = syntheticSeatId(roomId);
    const expiresAt = now + RESERVATION_TTL_MS;
    // Room, the synthetic seat, the opponent marking and the caller's consumed ticket: one
    // transaction or nothing. `createRoom` sets the room's own reservation clock; the ticket
    // mirrors its TTL so clients see one deadline.
    await createRoom(tx, {
      id: roomId,
      host: { id: user.id, username: user.username },
      // A ghost replays its own theme: the source book restored at match start was written for
      // it, so room and book never disagree. A bot takes a preset theme and generates normally.
      theme,
      mode: 'quick',
      reserved: [{ id: seatId, username: SYNTHETIC_OPPONENT_NAME }],
    });
    await tx
      .update(players)
      .set({ seated: 1, ready: 1, slot_expires_at: null })
      .where(and(eq(players.room_id, roomId), eq(players.user_id, seatId)));
    // The kind picks the runtime's opponent engine; only a ghost names its source replay.
    await updateRoom(
      tx,
      roomId,
      ghost ? { opponent_kind: 'ghost', ghost_id: ghost.id } : { opponent_kind: 'bot' },
    );
    await tx
      .update(matchTickets)
      .set({ state: 'matched', room_id: roomId, expires_at: expiresAt, updated_at: now })
      .where(eq(matchTickets.user_id, user.id));
    return { state: 'matched', roomId, expiresAt };
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
