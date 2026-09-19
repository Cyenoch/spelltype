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
import { accuracyOf, charCount, cpmOf, spellAt } from '../scoring';
import type { RoomSocket } from '../contracts';
import { INPUT_GATE_ERROR_MESSAGE, inputGateState } from './input-gate';
import { RoomRejection } from './rejection';
import { BOOK_PHASES, TIMED_PHASES, reservationIsGone } from './rules';
import type { RoomScope, SocketAuth, SocketRegistry } from './scope';
import { closeSocket, currentConns, currentProtocolSocket, sendTo } from './sockets';
import { abandonedMatch } from './storage/departures';
import { readEvents } from './storage/events';
import { countPlayers, getPlayer, listPlayers } from './storage/players';
import { getRoom } from './storage/room';
import type { RoomQuery } from './storage/query';
import { readSpellBook } from './storage/spell-book';
import type { PlayerRow, RoomRow } from '../db/schema';
import { matchRanks, participantKind } from './opponents';

type SnapshotContext = {
  room: RoomRow;
  players: PlayerRow[];
  /** 每次推送时解析一次，并在所有接收者的快照之间共享。 */
  book: Spell[];
  events: CombatEvent[];
  /** 各席位当前的连接 ID：唯一允许接收状态的套接字集合。 */
  conns: Set<string>;
  ranks: Map<string, number> | null;
  serverNow: number;
};

/**
 * 房间自身的快照查询。应用与握手时相同的准入规则，因此未入座的账户
 * 会收到对应原因提示，而不是读取到其不归属的房间。
 */
export async function snapshotFor(
  db: RoomQuery,
  roomId: string,
  registry: SocketRegistry,
  user: User,
): Promise<RoomSnapshot> {
  const room = await getRoom(db, roomId);
  if (!room) throw new RoomRejection('room:not_found', '房间不存在或已结束。');
  if (reservationIsGone(room, Date.now()))
    throw new RoomRejection('room:reservation_gone', '匹配已结束，请重新匹配。');

  const player = await getPlayer(db, roomId, user.id);
  if (!player) {
    if (room.mode === 'quick')
      throw new RoomRejection('room:reservation_gone', '匹配已结束，请重新匹配。');
    if (room.locked !== 0 || room.phase !== 'lobby')
      throw new RoomRejection('room:in_progress', '比赛已开始，无法加入。');
    if ((await countPlayers(db, roomId)) >= MAX_PRIVATE_PLAYERS)
      throw new RoomRejection('room:full', '房间已满。');
  } else if (await abandonedMatch(db, roomId, user.id, room.match_id)) {
    // 主动离开对本次对局是永久性的：该账户读取房间的权限并不比从未加入的账户多。
    throw new RoomRejection('room:reservation_gone', '你已离开本场对局。');
  }
  return buildSnapshot(await snapshotContext(db, roomId, registry, room), user.id);
}

async function snapshotContext(
  db: RoomQuery,
  roomId: string,
  registry: SocketRegistry,
  room: RoomRow,
): Promise<SnapshotContext> {
  const players = await listPlayers(db, roomId);
  const ranks =
    room.phase === 'finished' && room.match_id !== null ? matchRanks(room, players) : null;
  return {
    room,
    players,
    // 法术书在生成成功后即对所有人公开；无法读取或缺失法术书仅会导致所有玩家没有可用法术。
    book: BOOK_PHASES[room.phase] ? readSpellBook(room) : [],
    events: room.match_id !== null ? readEvents(room) : [],
    conns: await currentConns(db, roomId, registry),
    ranks,
    serverNow: Date.now(),
  };
}

/**
 * 当前时刻每活动分钟正确确认的字符数（CPM）：已完成字符数加上当前已接受的前缀，
 * 仅以战斗耗时计算。时钟在观察者自身被淘汰时停止，因此阵亡玩家的打字速度被冻结。
 */
function cpmFor(row: PlayerRow, room: RoomRow, now: number): number {
  const startedAt = room.started_at;
  if (startedAt === null) return 0;
  const activeEnd = row.eliminated_at ?? room.ended_at ?? now;
  return cpmOf(row.correct_chars + row.progress, Math.max(0, (activeEnd - startedAt) / 1_000));
}

function buildSnapshot(context: SnapshotContext, viewerId: string): RoomSnapshot {
  const room = context.room;
  // 只有观察者自己的法术才会离开房间发出：对手的文本绝不会发送。
  const book = context.book;
  const players: Player[] = context.players.map((row) => {
    const spell = spellAt(book, row.spell_index);
    const kind = participantKind(room, row);
    const spellLength = spell ? charCount(spell.text) : 0;
    const openedAt = row.input_opened_at;
    const nextAt = room.opponent_next_at;
    const progress =
      kind === 'bot' &&
      room.phase === 'playing' &&
      row.eliminated_at === null &&
      openedAt !== null &&
      nextAt !== null &&
      nextAt > openedAt
        ? Math.floor(
            spellLength *
              Math.max(0, Math.min(0.9, (context.serverNow - openedAt) / (nextAt - openedAt))),
          )
        : row.progress;
    return {
      id: row.user_id,
      username: row.username,
      kind,
      slot: row.slot,
      connected: kind !== 'human' || (row.conn_id !== null && context.conns.has(row.conn_id)),
      ready: kind !== 'human' || row.ready === 1,
      progress,
      spellLength,
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
  // 被淘汰的玩家既无可用法术可打，也没有活跃草稿可供重放。
  const spell =
    viewer !== null && viewer.eliminated_at === null ? spellAt(book, viewer.spell_index) : null;
  const typing = viewer !== null && room.phase === 'playing' && viewer.eliminated_at === null;
  // 限制门控是观察者与房间之间的私有契约：它仅在观察者于进行中的对局存活且有当前法术可输入时发布 ——
  // 当前法术为目标；已结算或正在结算的牌桌即使没有现存对手也不会将其隐藏。
  // 仅当持久化的资格状态与房间锁定的策略实际一致时才会发布，
  // 当前法术缺失的席位与其他损坏状态一样被视为损坏：
  // 返回 null 门控外加显式错误 —— 绝不会伪造零时刻“就绪” —— 从而使客户端停止提交，
  // 而不是将此状态视为正常。此处不执行任何写操作：快照读取绝不会修复或放大已损坏的行。
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
    opponentKind: room.opponent_kind,
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
 * 向每个席位发送其专有快照。分发遵循与其他操作相同的权限规则：
 * 仅当席位当前指向该连接时才可接收该席位的状态，因此被撤销或被替换的套接字
 * 不再是分发目标，即便其实际物理断开尚未完成 —— 而是会通知并关闭它，
 * 房间绝不会依赖关闭是否成功。
 */
export async function pushSnapshots(scope: RoomScope): Promise<void> {
  const room = await getRoom(scope.db, scope.roomId);
  if (!room) return;
  const context = await snapshotContext(scope.db, scope.roomId, scope.registry, room);
  for (const socket of scope.registry.list()) {
    if (socket.readyState !== 1) continue;
    const meta = scope.registry.metaOf(socket);
    if (!meta) continue;
    // 旧协议连接不是有效接收者：跳过它并交由唤醒扫描处理，
    // 唤醒扫描会使用协议错误码将其关闭 —— 快照推送绝不能伪装成连接替换。
    if (!currentProtocolSocket(meta)) continue;
    if (!context.conns.has(meta.connId)) {
      closeSocket(socket, WS_CLOSE.replaced, 'not the current connection');
      continue;
    }
    sendTo(socket, { type: 'state', room: buildSnapshot(context, meta.userId) });
  }
}

/** 使用专属快照响应单个套接字；席位不再指向的连接不会收到任何内容。 */
export async function sendSnapshotTo(
  db: RoomQuery,
  roomId: string,
  registry: SocketRegistry,
  socket: RoomSocket,
  meta: SocketAuth,
): Promise<void> {
  const room = await getRoom(db, roomId);
  if (!room) return;
  const context = await snapshotContext(db, roomId, registry, room);
  if (!context.conns.has(meta.connId)) return;
  sendTo(socket, { type: 'state', room: buildSnapshot(context, meta.userId) });
}
