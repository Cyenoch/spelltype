/**
 * The schema itself, exercised through the real migrated database — the constraints are the
 * multi-process safety net now that one PostgreSQL (PGlite here) database serves api and game
 * processes concurrently. Pinned here: room/ticket id formats, room state vocabularies, the
 * singleton runtime control row (mode vocabulary, one row only), seat slot uniqueness,
 * result-write idempotency, the one-ticket-per-account rule, session seat cascades, and the
 * integer-millisecond timestamp convention surviving a round trip. Transactions get their own
 * proof: a coordinator's pairing flow (room + seats + ticket in one transaction, committed or
 * rolled back whole) runs through code typed against `QueryDatabase`, the union every storage
 * function accepts.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Difficulty, Phase, RoomMode } from '../../shared/protocol';
import type { MaintenanceMode } from '../../shared/maintenance';
import type { MatchTicketState } from '../../server/db/schema';
import {
  accounts,
  departures,
  matchTickets,
  openDatabase,
  players,
  results,
  roomSessions,
  rooms,
  runtimeControl,
  sessions,
  type OpenedDatabase,
  type QueryDatabase,
} from '../../server/db';

const NOW = 1_700_000_000_000;
const TIMEOUT = 120_000;

const hex24 = (n: number) => n.toString(16).padStart(24, '0');

let db: OpenedDatabase['db'];
let opened: OpenedDatabase;
let seq = 0;

beforeAll(async () => {
  opened = await openDatabase('pglite://:memory:');
  db = opened.db;
}, TIMEOUT);

afterAll(async () => {
  await opened?.close();
});

const nextUserId = () => `user-${++seq}`;
const nextRoomId = () => hex24(1000 + ++seq);
const nextMatchId = () => `match-${++seq}`;
const nextTokenHash = () => `token-${++seq}`;

async function seedAccount(id: string) {
  await db.insert(accounts).values({
    id,
    username: id,
    wechat_identity: `union:${id}`,
    created_at: NOW,
  });
}

async function insertRoom(
  store: QueryDatabase,
  id: string,
  patch: Partial<typeof rooms.$inferInsert> = {},
) {
  await store.insert(rooms).values({
    id,
    host_id: 'host',
    mode: 'private',
    opponent_kind: 'human',
    ghost_id: null,
    opponent_next_at: null,
    theme: 'theme',
    difficulty: 'hard',
    phase: 'lobby',
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  });
}

async function insertPlayer(store: QueryDatabase, roomId: string, userId: string, slot: number) {
  await store.insert(players).values({
    room_id: roomId,
    user_id: userId,
    username: userId,
    slot,
    joined_at: NOW,
  });
}

async function insertResult(store: QueryDatabase, roomId: string, matchId: string, userId: string) {
  await store.insert(results).values({
    match_id: matchId,
    user_id: userId,
    room_id: roomId,
    theme: 'theme',
    damage_dealt: 40,
    hp_remaining: 2000,
    spells_cast: 3,
    correct_chars: 30,
    duration_ms: 12_345,
    rank: 1,
    cpm: 180,
    accuracy: 0.94,
    created_at: NOW,
  });
}

/**
 * Standardized SQLSTATE categories — the provider-independent contract of a failed write. The
 * drizzle wrapper's own message text is implementation detail; the categorized `code` on the
 * provider error in the cause chain is what any consumer (or another process) can rely on.
 */
const SQLSTATE = { unique: '23505', foreignKey: '23503', check: '23514' } as const;
type SqlStateCategory = keyof typeof SQLSTATE;

function causeChainHasSqlState(error: unknown, sqlstate: string): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && current.code === sqlstate) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** Runs the write, asserts it fails, and that the failure carries the standardized SQLSTATE. */
async function rejectsWithSqlState(
  run: () => Promise<unknown>,
  category: SqlStateCategory,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(causeChainHasSqlState(error, SQLSTATE[category])).toBe(true);
    return;
  }
  throw new Error(`expected the write to fail with SQLSTATE ${SQLSTATE[category]} (${category})`);
}

describe('runtime control', () => {
  it('is a singleton in maintenance-mode vocabulary, never two rows', async () => {
    const [row] = await db.select().from(runtimeControl);
    expect(row).toBeDefined();
    expect(row?.singleton).toBe(1);
    expect(['open', 'draining']).toContain(row?.mode);
    expect(typeof row?.revision).toBe('number');
    expect(typeof row?.updated_at).toBe('number');
    // The fresh development install starts open, with no runtime claiming the writer lease yet.
    expect(row?.mode).toBe('open');
    expect(row?.runtime_id).toBeNull();
    expect(row?.runtime_epoch).toBe(0);
    expect(row?.lease_until).toBeNull();

    // A second control row is a deployment split waiting to happen: the singleton refuses it.
    const badMode: string = 'paused';
    await rejectsWithSqlState(
      () =>
        db
          .insert(runtimeControl)
          .values({ singleton: 1, mode: badMode as MaintenanceMode, revision: 0, updated_at: NOW }),
      'check',
    );
    await rejectsWithSqlState(
      () =>
        db
          .insert(runtimeControl)
          .values({ singleton: 2, mode: 'open', revision: 0, updated_at: NOW }),
      'check',
    );
  });
});

describe('rooms and seats', () => {
  it('enforces the room state vocabulary and the 24-hex room id', async () => {
    // The drizzle $type() annotations reject these at compile time; the casts simulate any
    // untyped writer (raw SQL, another process) so the database CHECK constraints prove out.
    const badPhase: string = 'paused';
    const badMode: string = 'duel';
    const badDifficulty: string = 'easy';
    await rejectsWithSqlState(
      () => insertRoom(db, nextRoomId(), { phase: badPhase as Phase }),
      'check',
    );
    await rejectsWithSqlState(
      () => insertRoom(db, nextRoomId(), { mode: badMode as RoomMode }),
      'check',
    );
    await rejectsWithSqlState(
      () => insertRoom(db, nextRoomId(), { difficulty: badDifficulty as Difficulty }),
      'check',
    );
    await rejectsWithSqlState(() => insertRoom(db, 'NOT-HEX'), 'check');
  });

  it('carries the domain defaults the port expects and round-trips integer milliseconds', async () => {
    const id = nextRoomId();
    await insertRoom(db, id);
    const [row] = await db.select().from(rooms).where(eq(rooms.id, id));
    expect(row).toMatchObject({
      deadline: 0,
      events_json: '[]',
      event_seq: 0,
      generation_seq: 0,
      reservation_state: 'none',
      opponent_kind: 'human',
      ghost_id: null,
      opponent_next_at: null,
      locked: 0,
      persistence: 'idle',
      persist_attempts: 0,
      next_alarm_at: null,
    });
    expect(row?.created_at).toBe(NOW);
    expect(typeof row?.created_at).toBe('number');
  });

  it('never allows two seats in one slot and defaults a fresh seat correctly', async () => {
    const roomId = nextRoomId();
    const first = nextUserId();
    const second = nextUserId();
    await seedAccount(first);
    await seedAccount(second);
    await insertRoom(db, roomId);
    await insertPlayer(db, roomId, first, 0);
    await rejectsWithSqlState(() => insertPlayer(db, roomId, second, 0), 'unique');

    const [seat] = await db.select().from(players).where(eq(players.room_id, roomId));
    expect(seat).toMatchObject({
      hp: 2400,
      max_hp: 2400,
      seated: 0,
      ready: 0,
      progress: 0,
      spell_index: 0,
      spells_cast: 0,
      damage_dealt: 0,
      correct_chars: 0,
      attempt_total: 0,
      error_total: 0,
      cpm: 0,
      last_input: '',
      eliminated_at: null,
    });
  });

  it('cascades seats away when a room row is removed', async () => {
    const roomId = nextRoomId();
    const userId = nextUserId();
    await insertRoom(db, roomId);
    await insertPlayer(db, roomId, userId, 1);
    await db.delete(rooms).where(eq(rooms.id, roomId));
    const left = await db.select().from(players).where(eq(players.room_id, roomId));
    expect(left).toEqual([]);
  });
});

describe('results', () => {
  it('makes retried result writes idempotent and keeps the room reference honest', async () => {
    const roomId = nextRoomId();
    const userId = nextUserId();
    await insertRoom(db, roomId);
    const matchId = nextMatchId();

    await insertResult(db, roomId, matchId, userId);
    await rejectsWithSqlState(() => insertResult(db, roomId, matchId, userId), 'unique');
    // The room runtime's replay path: a duplicate inside the settling transaction is a no-op.
    await db
      .insert(results)
      .values({
        match_id: matchId,
        user_id: userId,
        room_id: roomId,
        theme: 'theme',
        damage_dealt: 40,
        hp_remaining: 2000,
        spells_cast: 3,
        correct_chars: 30,
        duration_ms: 12_345,
        rank: 1,
        cpm: 180,
        accuracy: null,
        created_at: NOW,
      })
      .onConflictDoNothing()
      .execute();
    expect(await db.select().from(results).where(eq(results.match_id, matchId))).toHaveLength(1);

    await rejectsWithSqlState(
      () => insertResult(db, hex24(999), nextMatchId(), userId),
      'foreignKey',
    );
  });
});

describe('match tickets', () => {
  it('allows one ticket per account with unique requests and a tight state vocabulary', async () => {
    const userId = nextUserId();
    const rivalUserId = nextUserId();
    await seedAccount(userId);
    await seedAccount(rivalUserId);
    const requestId = `req-${++seq}`;
    const insert = (patch: Partial<typeof matchTickets.$inferInsert>) =>
      db.insert(matchTickets).values({
        user_id: userId,
        request_id: requestId,
        username: userId,
        state: 'waiting',
        expires_at: NOW + 60_000,
        created_at: NOW,
        updated_at: NOW,
        ...patch,
      });

    await insert({});
    // Same account again: the one-ticket-per-account primary key fires, and the failed write
    // leaves the account's single ticket untouched.
    await rejectsWithSqlState(() => insert({}), 'unique');
    // Same request id on a different account: the global request uniqueness fires.
    await rejectsWithSqlState(() => insert({ user_id: rivalUserId }), 'unique');
    expect(
      await db.select().from(matchTickets).where(eq(matchTickets.user_id, userId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(matchTickets).where(eq(matchTickets.user_id, rivalUserId)),
    ).toHaveLength(0);
    const badTicketState: string = 'cancelling';
    await rejectsWithSqlState(() => insert({ state: badTicketState as MatchTicketState }), 'check');
    await rejectsWithSqlState(
      () =>
        db.insert(matchTickets).values({
          user_id: 'no-such-account',
          request_id: `req-${++seq}`,
          username: 'ghost',
          state: 'waiting',
          expires_at: NOW,
          created_at: NOW,
          updated_at: NOW,
        }),
      'foreignKey',
    );
  });

  it('lets a waiting ticket exist without a room and a matched ticket with one', async () => {
    const waitingUser = nextUserId();
    const matchedUser = nextUserId();
    const roomId = nextRoomId();
    await seedAccount(waitingUser);
    await seedAccount(matchedUser);
    await insertRoom(db, roomId);
    await db.insert(matchTickets).values({
      user_id: waitingUser,
      request_id: `req-${++seq}`,
      username: waitingUser,
      state: 'waiting',
      room_id: null,
      expires_at: NOW + 60_000,
      created_at: NOW,
      updated_at: NOW,
    });
    await db.insert(matchTickets).values({
      user_id: matchedUser,
      request_id: `req-${++seq}`,
      username: matchedUser,
      state: 'matched',
      room_id: roomId,
      expires_at: NOW + 60_000,
      created_at: NOW,
      updated_at: NOW,
    });
  });
});

describe('session seats', () => {
  it('keeps session references honest and clears them when the session dies', async () => {
    const userId = nextUserId();
    await seedAccount(userId);
    const roomId = nextRoomId();
    const tokenHash = nextTokenHash();
    await insertRoom(db, roomId);
    await rejectsWithSqlState(
      () =>
        db.insert(sessions).values({ token_hash: tokenHash, user_id: 'ghost', expires_at: NOW }),
      'foreignKey',
    );
    await db
      .insert(sessions)
      .values({ token_hash: tokenHash, user_id: userId, expires_at: NOW + 1000 });
    await db.insert(roomSessions).values({ session_hash: tokenHash, room_id: roomId });

    await db.delete(sessions).where(eq(sessions.token_hash, tokenHash));
    const seats = await db
      .select()
      .from(roomSessions)
      .where(eq(roomSessions.session_hash, tokenHash));
    expect(seats).toEqual([]);
  });
});

describe('departures', () => {
  it('records one departure per account per room', async () => {
    const roomId = nextRoomId();
    const userId = nextUserId();
    await insertRoom(db, roomId);
    const insert = () =>
      db
        .insert(departures)
        .values({ room_id: roomId, user_id: userId, match_id: null, departed_at: NOW });
    await insert();
    await rejectsWithSqlState(insert, 'unique');
  });
});

describe('transactions', () => {
  it('commits a pairing-shaped transaction whole through the QueryDatabase union', async () => {
    const committed = nextRoomId();
    const rolledBack = nextRoomId();
    const userId = nextUserId();

    await db.transaction(async (tx) => {
      await insertRoom(tx, committed, { mode: 'quick' });
      await insertPlayer(tx, committed, userId, 0);
    });
    const seats = await db.select().from(players).where(eq(players.room_id, committed));
    expect(seats).toHaveLength(1);

    await db
      .transaction(async (tx) => {
        await insertRoom(tx, rolledBack, { mode: 'quick' });
        await insertPlayer(tx, rolledBack, userId, 0);
        throw new Error('rollback');
      })
      .catch(() => {});

    expect(await db.select().from(rooms).where(eq(rooms.id, rolledBack))).toEqual([]);
    expect(await db.select().from(players).where(eq(players.room_id, rolledBack))).toEqual([]);
  });
});
