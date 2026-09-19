import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  MATCH_DURATION_MS,
  OPENING_COUNTDOWN_MS,
  WS_PROTOCOL,
  type OpponentKind,
  type Spell,
} from '../../shared/protocol';
import type { RoomSocket } from '../../server/contracts';
import { openDatabase, type OpenedDatabase } from '../../server/db';
import { accounts, results } from '../../server/db/schema';
import { chooseGhost } from '../../server/ghosts';
import { handleInput } from '../../server/rooms/combat';
import { maybeAutoStartTx } from '../../server/rooms/match';
import { initializeOpponentTx } from '../../server/rooms/opponents';
import { INPUT_MIN_MS_PER_CODE_POINT, INPUT_POLICY_VERSION } from '../../server/rooms/rules';
import {
  createRoomScope,
  SocketRegistry,
  type RoomScope,
  type SocketAuth,
} from '../../server/rooms/scope';
import { snapshotFor } from '../../server/rooms/snapshots';
import { readEvents } from '../../server/rooms/storage/events';
import { getPlayer, updatePlayer } from '../../server/rooms/storage/players';
import { createRoom, getRoom, updateRoom } from '../../server/rooms/storage/room';
import { advanceOnce } from '../../server/rooms/transitions';
import { advanceCombat } from '../../server/rooms/volleys';

const BOOK: Spell[] = Array.from({ length: 24 }, (_, index) => ({
  name: `Silver Flame ${index}`,
  text: 'The silver flame guards the gate'.padEnd(47, ' ') + String(index).padStart(2, '0') + '!',
  translation: '银色的火焰守护着大门。',
  element: 'fire',
}));
let opened: OpenedDatabase;
let directory: string;
let start: number;

function wire(roomId: string) {
  const registry = new SocketRegistry();
  const auth: SocketAuth = {
    userId: 'human',
    username: 'human',
    connId: `${roomId}-conn`,
    sessionHash: 'session',
    sessionExpires: start + 3_600_000,
    protocolVersion: WS_PROTOCOL,
  };
  const socket = { readyState: 1, send() {}, close() {} } as unknown as RoomSocket;
  registry.attach(socket, auth);
  const scope = createRoomScope({
    roomId,
    db: opened.db,
    registry,
    inputPolicyMode: 'enforce',
    generate: async () => {
      throw new Error('unexpected generation');
    },
    transact: (fn) => opened.db.transaction(fn),
  });
  return { scope, socket, auth };
}

async function room(kind: OpponentKind, id = 'a'.repeat(24), ghostId: string | null = null) {
  await createRoom(opened.db, {
    id,
    mode: 'quick',
    host: { id: 'human', username: 'human' },
    reserved: [{ id: `synthetic:${id}`, username: 'Opponent' }],
    theme: '火焰',
  });
  await updateRoom(opened.db, id, { opponent_kind: kind, ghost_id: ghostId });
  const h = wire(id);
  await updatePlayer(opened.db, id, 'human', { seated: 1, conn_id: h.auth.connId });
  await updatePlayer(opened.db, id, `synthetic:${id}`, {
    seated: 1,
    ready: 1,
    slot_expires_at: null,
  });
  return h;
}

async function playing(kind: OpponentKind) {
  const h = await room(kind);
  const id = h.scope.roomId;
  await updateRoom(opened.db, id, {
    phase: 'playing',
    match_id: `match-${id}`,
    locked: 1,
    started_at: start,
    deadline: start + MATCH_DURATION_MS,
    spell_book: JSON.stringify(BOOK),
    input_policy_version: INPUT_POLICY_VERSION,
    input_policy_mode: 'enforce',
    input_min_ms_per_code_point: INPUT_MIN_MS_PER_CODE_POINT,
    reservation_state: 'locked',
  });
  for (const userId of ['human', `synthetic:${id}`]) {
    await updatePlayer(opened.db, id, userId, {
      input_opened_at: start,
      input_not_before: start + BOOK[0].text.length * INPUT_MIN_MS_PER_CODE_POINT,
    });
  }
  await opened.db.transaction(async (tx) => initializeOpponentTx(tx, (await getRoom(tx, id))!));
  return h;
}

async function catchup(scope: RoomScope, at: number) {
  setSystemTime(at);
  for (let i = 0; i < 1000; i++) {
    if (!(await advanceCombat(scope, at))) return;
  }
  throw new Error('opponent deadlines did not converge');
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'spelltype-ghost-'));
  opened = await openDatabase(`pglite://${directory}`);
  start = Date.now();
  setSystemTime(start);
  await opened.db
    .insert(accounts)
    .values({ id: 'human', username: 'human', wechat_identity: 'union:human', created_at: start });
});
afterEach(async () => {
  setSystemTime();
  await opened.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('虚拟对手', () => {
  it('在仅有一位真人连接且无对手 WebSocket 的情况下启动人机对局', async () => {
    const h = await room('bot');
    await opened.db.transaction(async (tx) => {
      expect(
        await maybeAutoStartTx(
          tx,
          h.scope.roomId,
          h.scope.registry,
          (await getRoom(tx, h.scope.roomId))!,
          'enforce',
        ),
      ).toBe(true);
    });
    const snapshot = await snapshotFor(opened.db, h.scope.roomId, h.scope.registry, {
      id: 'human',
      username: 'human',
    });
    expect(snapshot.phase).toBe('generating');
    expect(snapshot.players.find((player) => player.kind === 'bot')).toMatchObject({
      connected: true,
      ready: true,
    });
  });

  it('在真人活跃时扣留致死的人机吟唱，但随后通过真实伤害淘汰挂机的玩家', async () => {
    const h = await playing('bot');
    await updatePlayer(opened.db, h.scope.roomId, 'human', {
      hp: 200,
      damage_dealt: 1000,
      spells_cast: 1,
      correct_chars: 50,
      input_opened_at: start + 5_000,
    });
    await updateRoom(opened.db, h.scope.roomId, { opponent_next_at: start + 10_000 });
    await catchup(h.scope, start + 10_100);
    expect((await getPlayer(opened.db, h.scope.roomId, 'human'))!.hp).toBe(200);
    expect(readEvents((await getRoom(opened.db, h.scope.roomId))!)).toEqual([]);
    await catchup(h.scope, start + 50_100);
    const snapshot = await snapshotFor(opened.db, h.scope.roomId, h.scope.registry, {
      id: 'human',
      username: 'human',
    });
    expect(snapshot).toMatchObject({ phase: 'finished', endReason: 'elimination' });
    expect(snapshot.players.find((player) => player.id === 'human')).toMatchObject({
      hp: 0,
      rank: 2,
    });
    expect(snapshot.events).toMatchObject([{ damage: 200, eliminated: true }]);
    const history = await opened.db.select().from(results);
    expect(history).toMatchObject([{ user_id: 'human', opponent_kind: 'bot', rank: 2 }]);
    expect(history.length).toBe(1);
  });

  it('在超时且玩家持续活跃但速度较慢时人机认输，不虚构血量或击杀', async () => {
    const h = await playing('bot');
    await updateRoom(opened.db, h.scope.roomId, { opponent_next_at: null });
    await updatePlayer(opened.db, h.scope.roomId, 'human', {
      hp: 400,
      damage_dealt: 200,
      spells_cast: 1,
      input_opened_at: start + MATCH_DURATION_MS - 2_000,
    });
    await catchup(h.scope, start + MATCH_DURATION_MS);
    const snapshot = await snapshotFor(opened.db, h.scope.roomId, h.scope.registry, {
      id: 'human',
      username: 'human',
    });
    expect(snapshot.endReason).toBe('bot_concession');
    expect(snapshot.players.find((player) => player.id === 'human')).toMatchObject({
      rank: 1,
      hp: 400,
      eliminatedAt: null,
    });
    expect(snapshot.players.find((player) => player.kind === 'bot')).toMatchObject({
      rank: 2,
      hp: 2400,
      eliminatedAt: null,
    });
    expect((await opened.db.select().from(results))[0]).toMatchObject({
      rank: 1,
      hp_remaining: 400,
    });
  });

  it('挂机领先者不会被人机判定为超时获胜', async () => {
    const h = await playing('bot');
    await updateRoom(opened.db, h.scope.roomId, { opponent_next_at: null });
    await updatePlayer(opened.db, h.scope.roomId, 'human', {
      spells_cast: 1,
      input_opened_at: start + 10_000,
    });
    await updatePlayer(opened.db, h.scope.roomId, `synthetic:${h.scope.roomId}`, { hp: 200 });
    await catchup(h.scope, start + MATCH_DURATION_MS);
    const snapshot = await snapshotFor(opened.db, h.scope.roomId, h.scope.registry, {
      id: 'human',
      username: 'human',
    });
    expect(snapshot.endReason).toBe('inactivity');
    expect(snapshot.players.find((player) => player.id === 'human')).toMatchObject({
      rank: 2,
      hp: 2400,
    });
    expect((await opened.db.select().from(results))[0]).toMatchObject({
      rank: 2,
      hp_remaining: 2400,
    });
  });

  it('记录击杀对手的真人对局并在重启后严格按时间序批次重放且仅重放一次', async () => {
    const source = await playing('human');
    for (let index = 0; index < 12; index++) {
      setSystemTime(start + (index + 1) * 2_000);
      await handleInput(source.scope, source.socket, source.auth, {
        type: 'input',
        matchId: `match-${source.scope.roomId}`,
        spellIndex: index,
        draftEpoch: 0,
        text: BOOK[index].text,
      });
      await catchup(source.scope, start + (index + 1) * 2_000 + 100);
    }
    const ghost = await opened.db.transaction((tx) => chooseGhost(tx, 'someone-else'));
    if (!ghost) throw new Error('completed human run was not archived');
    expect(await opened.db.transaction((tx) => chooseGhost(tx, 'human'))).toBeNull();
    expect(ghost.casts.map((cast) => cast.at)).toEqual(
      Array.from({ length: 12 }, (_, index) => (index + 1) * 2_000),
    );
    const replay = await room('ghost', 'b'.repeat(24), ghost.id);
    await opened.db.transaction(async (tx) => {
      await maybeAutoStartTx(
        tx,
        replay.scope.roomId,
        replay.scope.registry,
        (await getRoom(tx, replay.scope.roomId))!,
        'enforce',
      );
    });
    const replayStart = Date.now() + OPENING_COUNTDOWN_MS;
    setSystemTime(replayStart);
    await advanceOnce(replay.scope);
    await catchup(replay.scope, replayStart + 6_100);
    expect((await getPlayer(opened.db, replay.scope.roomId, 'human'))!.hp).toBe(1800);
    expect(
      readEvents((await getRoom(opened.db, replay.scope.roomId))!).map((event) => event.at),
    ).toEqual([2_100, 4_100, 6_100].map((offset) => replayStart + offset));
    await opened.close();
    opened = await openDatabase(`pglite://${directory}`);
    const recovered = wire(replay.scope.roomId);
    await catchup(recovered.scope, replayStart + 6_100);
    expect((await getPlayer(opened.db, replay.scope.roomId, 'human'))!.hp).toBe(1800);
    await catchup(recovered.scope, replayStart + 24_100);
    const snapshot = await snapshotFor(opened.db, replay.scope.roomId, recovered.scope.registry, {
      id: 'human',
      username: 'human',
    });
    expect(snapshot).toMatchObject({
      phase: 'finished',
      endReason: 'elimination',
      opponentKind: 'ghost',
    });
    expect(snapshot.players.find((player) => player.id === 'human')).toMatchObject({
      hp: 0,
      rank: 2,
    });
    expect(snapshot.events.map((event) => event.at)).toEqual(
      Array.from({ length: 12 }, (_, index) => replayStart + (index + 1) * 2_000 + 100),
    );
    const history = await opened.db
      .select()
      .from(results)
      .where(eq(results.room_id, replay.scope.roomId));
    expect(
      history.map((row) => ({ user: row.user_id, rank: row.rank, kind: row.opponent_kind })),
    ).toEqual([{ user: 'human', rank: 2, kind: 'ghost' }]);
  });
});
