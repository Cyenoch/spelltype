import { MAX_PRIVATE_PLAYERS, WS_CLOSE, WS_PROTOCOL } from '../../shared/protocol';
import type {
  CombatEvent,
  Player,
  RoomSnapshot,
  SelfInputGate,
  SelfInputStats,
  Spell,
  User,
} from '../../shared/protocol';
import { accuracyOf, charCount, cpmOf, spellAt, survivalRanks } from '../scoring';
import { INPUT_GATE_ERROR_MESSAGE, inputGateState } from './input-gate';
import { RoomRejection } from './rejection';
import { BOOK_PHASES, TIMED_PHASES, reservationIsGone } from './rules';
import type { RoomScope } from './scope';
import {
  closeSocket,
  currentConns,
  currentProtocolSocket,
  readSocketMeta,
  sendTo,
} from './sockets';
import type { SocketAuth } from './sockets';
import { abandonedMatch } from './storage/departures';
import { readEvents } from './storage/events';
import { countPlayers, getPlayer, listPlayers } from './storage/players';
import { getRoom } from './storage/room';
import type { PlayerRow, RoomRow } from './storage/schema';
import { readSpellBook } from './storage/spell-book';

type SnapshotContext = {
  room: RoomRow;
  players: PlayerRow[];
  /** Parsed once per push and shared by every recipient's snapshot. */
  book: Spell[];
  events: CombatEvent[];
  /** The seats' current connection ids: the only sockets allowed to receive state. */
  conns: Set<string>;
  ranks: Map<string, number> | null;
  serverNow: number;
};

/**
 * The room's own snapshot query. The same admission rules apply as at the handshake, so an account
 * that is not seated is told why instead of reading a room it does not belong to.
 */
export function snapshotFor(scope: RoomScope, user: User): RoomSnapshot {
  const room = getRoom(scope.sql);
  if (!room) throw new RoomRejection('room:not_found', '房间不存在或已结束。');
  if (reservationIsGone(room, Date.now()))
    throw new RoomRejection('room:reservation_gone', '匹配已结束，请重新匹配。');

  const player = getPlayer(scope.sql, user.id);
  if (!player) {
    if (room.mode === 'quick')
      throw new RoomRejection('room:reservation_gone', '匹配已结束，请重新匹配。');
    if (room.locked !== 0 || room.phase !== 'lobby')
      throw new RoomRejection('room:in_progress', '比赛已开始，无法加入。');
    if (countPlayers(scope.sql) >= MAX_PRIVATE_PLAYERS)
      throw new RoomRejection('room:full', '房间已满。');
  } else if (abandonedMatch(scope.sql, user.id, room.match_id)) {
    // An explicit departure is permanent for this match: the account reads the
    // room no more than an account that never joined it.
    throw new RoomRejection('room:reservation_gone', '你已离开本场对局。');
  }
  return buildSnapshot(snapshotContext(scope, room), user.id);
}

function snapshotContext(scope: RoomScope, room: RoomRow): SnapshotContext {
  const players = listPlayers(scope.sql);
  const ranks =
    room.phase === 'finished' && room.match_id !== null
      ? survivalRanks(
          players.map((row) => ({
            userId: row.user_id,
            hp: row.hp,
            eliminatedAt: row.eliminated_at,
          })),
        )
      : null;
  return {
    room,
    players,
    // The book is public the moment generation succeeds; an unreadable or
    // absent one simply leaves every player without a spell.
    book: BOOK_PHASES[room.phase] ? readSpellBook(room) : [],
    events: room.match_id !== null ? readEvents(room) : [],
    conns: currentConns(scope),
    ranks,
    serverNow: Date.now(),
  };
}

/**
 * Correct confirmed characters per active minute at this instant: completed
 * characters plus the current accepted prefix, over combat time only. The
 * clock stops at the viewer's own elimination, so a corpse's speed is frozen.
 */
function cpmFor(row: PlayerRow, room: RoomRow, now: number): number {
  const startedAt = room.started_at;
  if (startedAt === null) return 0;
  const activeEnd = row.eliminated_at ?? room.ended_at ?? now;
  return cpmOf(row.correct_chars + row.progress, Math.max(0, (activeEnd - startedAt) / 1_000));
}

function buildSnapshot(context: SnapshotContext, viewerId: string): RoomSnapshot {
  const room = context.room;
  // Only the viewer's own spell ever leaves the room: rivals' texts are never sent.
  const book = context.book;
  const players: Player[] = context.players.map((row) => {
    const spell = spellAt(book, row.spell_index);
    return {
      id: row.user_id,
      username: row.username,
      slot: row.slot,
      connected: row.conn_id !== null && context.conns.has(row.conn_id),
      ready: row.ready === 1,
      progress: row.progress,
      spellLength: spell ? charCount(spell.text) : 0,
      spellIndex: row.spell_index,
      spellsCast: row.spells_cast,
      hp: row.hp,
      maxHp: row.max_hp,
      damageDealt: row.damage_dealt,
      correctChars: row.correct_chars,
      eliminatedAt: row.eliminated_at,
      cpm: cpmFor(row, room, context.serverNow),
      accuracy: accuracyOf(row.attempt_total, row.error_total),
      rank: context.ranks?.get(row.user_id) ?? null,
    };
  });
  const viewer = context.players.find((row) => row.user_id === viewerId) ?? null;
  // An eliminated player has no spell to type and no live draft to replay.
  const spell =
    viewer !== null && viewer.eliminated_at === null ? spellAt(book, viewer.spell_index) : null;
  const typing = viewer !== null && room.phase === 'playing' && viewer.eliminated_at === null;
  // The gate is the viewer's private contract with the room: it is published while the
  // viewer is alive in a playing match with a current spell to type — the spell is the
  // target; a settled-or-settling table with no standing opponent does not hide it. It is
  // published only when the stored eligibility actually agrees with the room's locked
  // policy, and a seat whose current spell is missing is damaged like any other incoherent
  // state: null gates plus an explicit error — never a forged zero-moment "ready" — so the
  // client stops submitting instead of treating the state as sane. Nothing here writes: a
  // snapshot read never repairs or amplifies a damaged row.
  let selfInputGate: SelfInputGate = null;
  let selfInputStats: SelfInputStats = null;
  let damagedGate = false;
  if (typing && viewer !== null) {
    if (spell === null) {
      damagedGate = true;
    } else {
      const gate = inputGateState(room, viewer, charCount(spell.text));
      if (gate === null) {
        damagedGate = true;
      } else {
        selfInputGate = {
          policyVersion: gate.policyVersion,
          mode: gate.mode,
          draftEpoch: viewer.draft_epoch,
          notBefore: gate.notBefore,
          resetReason: viewer.input_reset_reason,
        };
        selfInputStats = {
          attemptTotal: viewer.attempt_total,
          errorTotal: viewer.error_total,
        };
      }
    }
  }
  return {
    id: room.id,
    matchId: room.match_id,
    hostId: room.host_id,
    mode: room.mode,
    theme: room.theme,
    difficulty: room.difficulty,
    phase: room.phase,
    deadline: TIMED_PHASES[room.phase] ? room.deadline : 0,
    serverNow: context.serverNow,
    startedAt: room.started_at,
    endedAt: room.ended_at,
    endReason: room.end_reason,
    protocolVersion: WS_PROTOCOL,
    spell,
    selfInput: typing && viewer !== null ? viewer.last_input : '',
    selfInputGate,
    selfInputStats,
    events: context.events,
    persistence: room.persistence,
    reservationExpiresAt:
      room.reservation_state === 'reserved' ? room.reservation_expires_at : null,
    players,
    error: damagedGate ? (room.error ?? INPUT_GATE_ERROR_MESSAGE) : room.error,
  };
}

/**
 * Sends every seat its own snapshot. Delivery follows the same authority rule
 * as everything else: only a connection the seat currently points at may
 * receive that seat's state, so a revoked or replaced socket stops being a
 * delivery target even if its physical close has not landed — it is told and
 * closed instead, and the room never depends on a close succeeding.
 */
export function pushSnapshots(scope: RoomScope): void {
  const room = getRoom(scope.sql);
  if (!room) return;
  const context = snapshotContext(scope, room);
  for (const ws of scope.sockets()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const meta = readSocketMeta(ws);
    if (!meta) continue;
    // A stale-protocol attachment is not a receiver: skip it and leave the
    // cut-off to the wake-up sweep, which closes it with the protocol code —
    // a snapshot push must never masquerade as a replacement.
    if (!currentProtocolSocket(meta)) continue;
    if (!context.conns.has(meta.connId)) {
      closeSocket(ws, WS_CLOSE.replaced, 'not the current connection');
      continue;
    }
    sendTo(ws, { type: 'state', room: buildSnapshot(context, meta.userId) });
  }
}

/** Answers one socket with its own snapshot; a connection the seat no longer points at gets nothing. */
export function sendSnapshotTo(scope: RoomScope, ws: WebSocket, meta: SocketAuth): void {
  const room = getRoom(scope.sql);
  if (!room) return;
  const context = snapshotContext(scope, room);
  if (!context.conns.has(meta.connId)) return;
  sendTo(ws, { type: 'state', room: buildSnapshot(context, meta.userId) });
}
