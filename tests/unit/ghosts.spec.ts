/**
 * The ghost fallback's storage contract, exercised through the real migrated database: accepted
 * cast recording, publication eligibility (contiguity, pacing, bounds, damage, policy, book),
 * the immutable archive rows, bounded current-only selection, and the new schema vocabularies.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { OpponentKind, Spell } from '../../shared/protocol';
import {
  accounts,
  ghostCasts,
  ghosts,
  openDatabase,
  players,
  results,
  rooms,
  type OpenedDatabase,
  type QueryDatabase,
} from '../../server/db';
import {
  GHOST_RULES_VERSION,
  chooseGhost,
  getGhost,
  publishGhostsTx,
  recordCastTx,
} from '../../server/ghosts';

const NOW = 1_700_000_000_000;
const STARTED_AT = NOW + 1_000;
const DEADLINE_MS = 60_000;
/** The current input floor: one code point costs 35ms, so a 100-code-point spell costs 3500ms. */
const SPELL_MS = 3_500;
const TIMEOUT = 120_000;

/** Two spells of 100 code points each; six casts wrap the book and deal exactly full health. */
const BOOK: Spell[] = [
  { name: 'A', text: 'a'.repeat(100), translation: '甲', element: 'fire' },
  { name: 'B', text: 'b'.repeat(100), translation: '乙', element: 'ice' },
];
const CASTS = 6;
const FULL_DAMAGE = 4 * 100 * CASTS;

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
const nextRoomId = () => hex24(2000 + ++seq);
const nextMatchId = () => `match-${++seq}`;

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
    theme: '主题',
    difficulty: 'hard',
    phase: 'playing',
    match_id: nextMatchId(),
    started_at: STARTED_AT,
    deadline: STARTED_AT + DEADLINE_MS,
    spell_book: JSON.stringify(BOOK),
    input_policy_version: 'ascii-floor-v1',
    input_policy_mode: 'enforce',
    input_min_ms_per_code_point: 35,
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  });
  const rows = await store.select().from(rooms).where(eq(rooms.id, id)).limit(1);
  return rows[0];
}

async function insertSeat(
  store: QueryDatabase,
  roomId: string,
  userId: string,
  slot: number,
  patch: Partial<typeof players.$inferInsert> = {},
) {
  await store.insert(players).values({
    room_id: roomId,
    user_id: userId,
    username: userId,
    slot,
    joined_at: NOW,
    ...patch,
  });
  const rows = await store.select().from(players).where(eq(players.user_id, userId)).limit(1);
  return rows[0];
}

/** The cast offsets of an honest six-cast trace: one spell-cost apart, inside the deadline. */
const honestOffsets = (count = CASTS) =>
  Array.from({ length: count }, (_, index) => SPELL_MS * (index + 1));

async function recordTrace(roomId: string, matchId: string, userId: string, offsets: number[]) {
  for (const [index, at] of offsets.entries()) {
    await db.insert(ghostCasts).values({
      room_id: roomId,
      match_id: matchId,
      user_id: userId,
      spell_index: index,
      at,
    });
  }
}

async function ghostsOf(sourceUserId: string) {
  return db.select().from(ghosts).where(eq(ghosts.source_user_id, sourceUserId));
}

async function seatCastCount(roomId: string) {
  const rows = await db.select().from(ghostCasts).where(eq(ghostCasts.room_id, roomId));
  return rows.length;
}

/** Standardized SQLSTATE categories — the provider-independent contract of a failed write. */
const SQLSTATE = { check: '23514' } as const;

function causeChainHasSqlState(error: unknown, sqlstate: string): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && current.code === sqlstate) return true;
    current = 'cause' in current ? current.cause : null;
  }
  return false;
}

async function rejectsWithSqlState(run: () => Promise<unknown>, sqlstate: string) {
  try {
    await run();
  } catch (error) {
    expect(causeChainHasSqlState(error, sqlstate)).toBe(true);
    return;
  }
  throw new Error(`expected the write to fail with ${sqlstate}`);
}

describe('ghost recording', () => {
  it('stores a human seat’s accepted cast as an offset from started_at', async () => {
    const userId = nextUserId();
    await seedAccount(userId);
    const roomId = nextRoomId();
    const room = await insertRoom(db, roomId);
    const seat = await insertSeat(db, roomId, userId, 1, { spell_index: 2 });
    await recordCastTx(db, room, seat, STARTED_AT + 9_500);
    const rows = await db.select().from(ghostCasts).where(eq(ghostCasts.user_id, userId));
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      room_id: roomId,
      match_id: room.match_id,
      spell_index: 2,
      at: 9_500,
    });
  });

  it('absorbs a replayed acceptance instead of failing the cast', async () => {
    const userId = nextUserId();
    await seedAccount(userId);
    const room = await insertRoom(db, nextRoomId());
    const seat = await insertSeat(db, room.id, userId, 1, { spell_index: 1 });
    await recordCastTx(db, room, seat, STARTED_AT + 3_500);
    await recordCastTx(db, room, seat, STARTED_AT + 3_500);
    const rows = await db.select().from(ghostCasts).where(eq(ghostCasts.user_id, userId));
    expect(rows.length).toBe(1);
  });

  it('records nothing for ghost and bot rooms', async () => {
    const userId = nextUserId();
    await seedAccount(userId);
    const ghostRoom = await insertRoom(db, nextRoomId(), { opponent_kind: 'ghost' });
    const botRoom = await insertRoom(db, nextRoomId(), { opponent_kind: 'bot' });
    const seat = await insertSeat(db, ghostRoom.id, userId, 1);
    await recordCastTx(db, ghostRoom, seat, STARTED_AT + 3_500);
    const botSeat = await insertSeat(db, botRoom.id, userId, 1);
    await recordCastTx(db, botRoom, botSeat, STARTED_AT + 3_500);
    expect(await seatCastCount(ghostRoom.id)).toBe(0);
    expect(await seatCastCount(botRoom.id)).toBe(0);
  });

  it('loses its rows with the room through the cascade', async () => {
    const userId = nextUserId();
    await seedAccount(userId);
    const room = await insertRoom(db, nextRoomId());
    const seat = await insertSeat(db, room.id, userId, 1);
    await recordCastTx(db, room, seat, STARTED_AT + 3_500);
    expect(await seatCastCount(room.id)).toBe(1);
    await db.delete(rooms).where(eq(rooms.id, room.id));
    expect(await seatCastCount(room.id)).toBe(0);
  });
});

describe('ghost publication', () => {
  it('archives one immutable ghost per qualifying seat and clears the trace', async () => {
    const hostId = nextUserId();
    const guestId = nextUserId();
    await seedAccount(hostId);
    await seedAccount(guestId);
    const room = await insertRoom(db, nextRoomId(), { host_id: hostId });
    const host = await insertSeat(db, room.id, hostId, 0, {
      spells_cast: CASTS,
      damage_dealt: FULL_DAMAGE,
    });
    const guest = await insertSeat(db, room.id, guestId, 1, {
      spells_cast: CASTS,
      damage_dealt: FULL_DAMAGE,
    });
    await recordTrace(room.id, room.match_id!, hostId, honestOffsets());
    await recordTrace(room.id, room.match_id!, guestId, honestOffsets());

    await publishGhostsTx(db, room, [host, guest]);

    const archived = [...(await ghostsOf(hostId)), ...(await ghostsOf(guestId))];
    expect(archived.length).toBe(2);
    const hostGhost = (await ghostsOf(hostId))[0];
    expect(hostGhost.rules_version).toBe(GHOST_RULES_VERSION);
    expect(hostGhost.theme).toBe(room.theme);
    expect(hostGhost.book).toEqual(BOOK);
    expect(hostGhost.casts).toEqual(
      honestOffsets().map((at, index) => ({ at, spellIndex: index })),
    );
    const guestGhost = (await ghostsOf(guestId))[0];
    expect(guestGhost.casts).toEqual(
      honestOffsets().map((at, index) => ({ at, spellIndex: index })),
    );
    expect(await seatCastCount(room.id)).toBe(0);
  });

  it('refuses a trace paced faster than the current input floor', async () => {
    const userId = nextUserId();
    await seedAccount(userId);
    const room = await insertRoom(db, nextRoomId(), { host_id: userId });
    const seat = await insertSeat(db, room.id, userId, 0, {
      spells_cast: CASTS,
      damage_dealt: FULL_DAMAGE,
    });
    // The first cast completes before spell 0's full cost has elapsed.
    await recordTrace(room.id, room.match_id!, userId, [SPELL_MS - 1, ...honestOffsets().slice(1)]);

    await publishGhostsTx(db, room, [seat]);

    expect((await ghostsOf(userId)).length).toBe(0);
    expect(await seatCastCount(room.id)).toBe(0);
  });

  it('refuses a trace whose book prefix is not contiguous', async () => {
    const userId = nextUserId();
    await seedAccount(userId);
    const room = await insertRoom(db, nextRoomId(), { host_id: userId });
    const seat = await insertSeat(db, room.id, userId, 0, {
      spells_cast: 3,
      damage_dealt: FULL_DAMAGE,
    });
    // Rows 0, 2, 3 are three rows — the right count — but index 1 is missing.
    const offsets = honestOffsets(4).filter((_, index) => index !== 1);
    await db.insert(ghostCasts).values(
      offsets.map((at, position) => ({
        room_id: room.id,
        match_id: room.match_id!,
        user_id: userId,
        spell_index: [0, 2, 3][position],
        at,
      })),
    );

    await publishGhostsTx(db, room, [seat]);

    expect((await ghostsOf(userId)).length).toBe(0);
    expect(await seatCastCount(room.id)).toBe(0);
  });

  it('refuses a seat whose recorded casts disagree with its cursor', async () => {
    const userId = nextUserId();
    await seedAccount(userId);
    const room = await insertRoom(db, nextRoomId(), { host_id: userId });
    const seat = await insertSeat(db, room.id, userId, 0, {
      spells_cast: CASTS,
      damage_dealt: FULL_DAMAGE,
    });
    // One accepted cast never made it to the trace: 5 rows against spells_cast 6.
    await recordTrace(room.id, room.match_id!, userId, honestOffsets(CASTS - 1));

    await publishGhostsTx(db, room, [seat]);

    expect((await ghostsOf(userId)).length).toBe(0);
    expect(await seatCastCount(room.id)).toBe(0);
  });

  it('refuses a seat below the full-health damage threshold', async () => {
    const userId = nextUserId();
    await seedAccount(userId);
    const room = await insertRoom(db, nextRoomId(), { host_id: userId });
    const seat = await insertSeat(db, room.id, userId, 0, {
      spells_cast: CASTS,
      damage_dealt: FULL_DAMAGE - 1,
    });
    await recordTrace(room.id, room.match_id!, userId, honestOffsets());

    await publishGhostsTx(db, room, [seat]);

    expect((await ghostsOf(userId)).length).toBe(0);
    expect(await seatCastCount(room.id)).toBe(0);
  });

  it('bounds a survivor by the deadline and a fallen seat by its elimination', async () => {
    const survivorId = nextUserId();
    const fallenId = nextUserId();
    await seedAccount(survivorId);
    await seedAccount(fallenId);
    const room = await insertRoom(db, nextRoomId(), { host_id: survivorId });
    const survivor = await insertSeat(db, room.id, survivorId, 0, {
      spells_cast: CASTS,
      damage_dealt: FULL_DAMAGE,
    });
    await recordTrace(room.id, room.match_id!, survivorId, [
      ...honestOffsets(CASTS - 1),
      DEADLINE_MS + 1,
    ]);
    const fallenRoom = await insertRoom(db, nextRoomId(), { host_id: fallenId });
    const fallen = await insertSeat(db, fallenRoom.id, fallenId, 0, {
      spells_cast: 2,
      damage_dealt: FULL_DAMAGE,
      eliminated_at: STARTED_AT + 4_000,
    });
    await recordTrace(fallenRoom.id, fallenRoom.match_id!, fallenId, [SPELL_MS, SPELL_MS * 2]);

    await publishGhostsTx(db, room, [survivor]);
    await publishGhostsTx(db, fallenRoom, [fallen]);

    expect((await ghostsOf(survivorId)).length).toBe(0);
    expect((await ghostsOf(fallenId)).length).toBe(0);
    expect(await seatCastCount(room.id)).toBe(0);
    expect(await seatCastCount(fallenRoom.id)).toBe(0);
  });

  it('refuses a room whose policy or book is not the trusted current shape', async () => {
    const stalePolicyId = nextUserId();
    const badBookId = nextUserId();
    await seedAccount(stalePolicyId);
    await seedAccount(badBookId);
    const staleRoom = await insertRoom(db, nextRoomId(), {
      host_id: stalePolicyId,
      input_policy_version: 'ascii-floor-v0',
    });
    const staleSeat = await insertSeat(db, staleRoom.id, stalePolicyId, 0, {
      spells_cast: 1,
      damage_dealt: FULL_DAMAGE,
    });
    await recordTrace(staleRoom.id, staleRoom.match_id!, stalePolicyId, [SPELL_MS]);
    const badRoom = await insertRoom(db, nextRoomId(), {
      host_id: badBookId,
      spell_book: JSON.stringify([{ name: 'X', text: 'x', translation: '丙', element: 'poison' }]),
    });
    const badSeat = await insertSeat(db, badRoom.id, badBookId, 0, {
      spells_cast: 1,
      damage_dealt: FULL_DAMAGE,
    });
    await recordTrace(badRoom.id, badRoom.match_id!, badBookId, [SPELL_MS]);

    await publishGhostsTx(db, staleRoom, [staleSeat]);
    await publishGhostsTx(db, badRoom, [badSeat]);

    expect((await ghostsOf(stalePolicyId)).length).toBe(0);
    expect((await ghostsOf(badBookId)).length).toBe(0);
    expect(await seatCastCount(staleRoom.id)).toBe(0);
    expect(await seatCastCount(badRoom.id)).toBe(0);
  });

  it('does nothing but cleanup for ghost and bot rooms', async () => {
    const hostId = nextUserId();
    await seedAccount(hostId);
    const ghostRoom = await insertRoom(db, nextRoomId(), {
      host_id: hostId,
      opponent_kind: 'ghost',
    });
    const seat = await insertSeat(db, ghostRoom.id, hostId, 0, {
      spells_cast: 1,
      damage_dealt: FULL_DAMAGE,
    });
    await recordTrace(ghostRoom.id, ghostRoom.match_id!, hostId, [SPELL_MS]);
    const botRoom = await insertRoom(db, nextRoomId(), { host_id: hostId, opponent_kind: 'bot' });

    await publishGhostsTx(db, ghostRoom, [seat]);
    await publishGhostsTx(db, botRoom, []);

    expect((await ghostsOf(hostId)).length).toBe(0);
    expect(await seatCastCount(ghostRoom.id)).toBe(0);
  });
});

describe('ghost selection', () => {
  it('serves nothing when no compatible ghost exists', async () => {
    // A private migrated database, because the shared fixture database already carries ghosts
    // from the publication scenarios and this assertion needs a genuinely empty pool.
    const isolated = await openDatabase('pglite://:memory:');
    try {
      const seeker = 'user-isolated-seeker';
      await isolated.db.insert(accounts).values({
        id: seeker,
        username: seeker,
        wechat_identity: `union:${seeker}`,
        created_at: NOW,
      });
      const chosen = await chooseGhost(isolated.db, seeker);
      expect(chosen).toBeNull();
      const missing = await getGhost(isolated.db, 'no-such-ghost');
      expect(missing).toBeNull();
    } finally {
      await isolated.close();
    }
  });

  it('serves only current-compatible ghosts, never the seeker’s own', async () => {
    // Isolated for the same reason: the pool here is exactly the three rows under test, so the
    // uniform pick can be asserted to always be the one eligible ghost.
    const isolated = await openDatabase('pglite://:memory:');
    try {
      const seeker = 'user-isolated-seeker';
      const other = 'user-isolated-other';
      for (const id of [seeker, other]) {
        await isolated.db.insert(accounts).values({
          id,
          username: id,
          wechat_identity: `union:${id}`,
          created_at: NOW,
        });
      }
      const ownGhost = {
        id: 'ghost-isolated-own',
        source_user_id: seeker,
        theme: '主题',
        book: BOOK,
        casts: [{ at: SPELL_MS, spellIndex: 0 }],
        rules_version: GHOST_RULES_VERSION,
        created_at: NOW,
      };
      await isolated.db.insert(ghosts).values(ownGhost);
      await isolated.db
        .insert(ghosts)
        .values({ ...ownGhost, id: 'ghost-isolated-other', source_user_id: other });
      await isolated.db.insert(ghosts).values({
        ...ownGhost,
        id: 'ghost-isolated-stale',
        source_user_id: other,
        rules_version: 'ghosts.v0+spelltype.v2',
      });

      for (let pick = 0; pick < 30; pick++) {
        const chosen = await chooseGhost(isolated.db, seeker);
        expect(chosen).not.toBeNull();
        expect(chosen?.rules_version).toBe(GHOST_RULES_VERSION);
        expect(chosen?.source_user_id).toBe(other);
      }

      const own = await getGhost(isolated.db, ownGhost.id);
      expect(own).toMatchObject({ id: ownGhost.id });
      const stale = await getGhost(isolated.db, 'ghost-isolated-stale');
      expect(stale).toBeNull();
    } finally {
      await isolated.close();
    }
  });
});

describe('ghost schema constraints', () => {
  it('defaults new rooms and results to plain human behavior', async () => {
    const userId = nextUserId();
    await seedAccount(userId);
    const room = await insertRoom(db, nextRoomId(), {
      phase: 'lobby',
      match_id: null,
      started_at: null,
      deadline: 0,
      spell_book: null,
    });
    expect(room.opponent_kind).toBe('human');
    expect(room.ghost_id).toBeNull();
    expect(room.opponent_next_at).toBeNull();
    const matchId = nextMatchId();
    await db.insert(results).values({
      match_id: matchId,
      user_id: userId,
      room_id: room.id,
      theme: room.theme,
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
    const rows = await db
      .select({ opponent_kind: results.opponent_kind })
      .from(results)
      .where(eq(results.match_id, matchId));
    expect(rows[0].opponent_kind).toBe('human');
  });

  it('accepts the new end reasons and opponent kinds on stored rooms', async () => {
    const conceded = await insertRoom(db, nextRoomId(), {
      end_reason: 'bot_concession',
      opponent_kind: 'bot',
    });
    expect(conceded.end_reason).toBe('bot_concession');
    const inactive = await insertRoom(db, nextRoomId(), {
      end_reason: 'inactivity',
      opponent_kind: 'ghost',
    });
    expect(inactive.end_reason).toBe('inactivity');
    expect(inactive.opponent_kind).toBe('ghost');
  });

  it('rejects opponent kinds outside the vocabulary', async () => {
    await rejectsWithSqlState(
      () =>
        insertRoom(db, nextRoomId(), {
          opponent_kind: 'alien' as unknown as OpponentKind,
        }),
      SQLSTATE.check,
    );
    const userId = nextUserId();
    await seedAccount(userId);
    const room = await insertRoom(db, nextRoomId());
    await insertSeat(db, room.id, userId, 0);
    await rejectsWithSqlState(
      () =>
        db.insert(results).values({
          match_id: nextMatchId(),
          user_id: userId,
          room_id: room.id,
          theme: room.theme,
          opponent_kind: 'alien' as unknown as OpponentKind,
          damage_dealt: 40,
          hp_remaining: 2000,
          spells_cast: 3,
          correct_chars: 30,
          duration_ms: 12_345,
          rank: 1,
          cpm: 180,
          accuracy: 0.94,
          created_at: NOW,
        }),
      SQLSTATE.check,
    );
  });
});
