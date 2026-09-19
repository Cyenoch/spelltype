import { MAX_QUICK_PLAYERS, OPENING_COUNTDOWN_MS } from '../../shared/protocol';
import type { EndReason, InputPolicyMode } from '../../shared/protocol';
import type { Transaction } from '../db';
import { readMaintenance } from '../maintenance/control';
import { accuracyOf, cpmOf } from '../scoring';
import {
  MIN_PLAYERS,
  reservationIsLive,
  INPUT_MIN_MS_PER_CODE_POINT,
  INPUT_POLICY_VERSION,
} from './rules';
import type { SocketRegistry } from './scope';
import { currentConns, onlineUserIds } from './sockets';
import {
  countPlayers,
  deleteReservedSeats,
  listPlayers,
  resetPlayersForMatch,
  updatePlayer,
} from './storage/players';
import { insertResults } from './storage/results';
import { getRoom, updateRoom } from './storage/room';
import type { ResultInsert, RoomRow } from '../db/schema';
import { clearVolley, readVolley } from './storage/volley';
import { reportGateStateInvalid, roomPolicyValid } from './input-gate';
import { getGhost, publishGhostsTx } from '../ghosts';
import { matchRanks, participantKind, terminalReason } from './opponents';

/**
 * 锁定名单并准备新对局，若为残影对手则复用源法术书。
 * 在调用方的事务内执行，因此绝不会观察到半启动的房间状态；
 * 拒绝启动所写入的回复是房间自身的数据字段。
 *
 * 开始阶段受两条准入规则限制，两者均从提交开始的同一个事务中持久化读取：
 * 1. 来自 `runtime_control` 的全局维护准入（排空状态会暂停新对局，而运行中的对局及其已发布的快速预留保持各自的时钟）；
 * 2. 打字时间策略模式，在此处进行验证并在整个对局生命周期中锁定至房间数据行。
 * 两种拒绝均为业务响应而非抛出异常：携带其他已提交工作（加入、席位对齐）的调用方可保留该工作。
 */
export async function startMatchTx(
  tx: Transaction,
  roomId: string,
  room: RoomRow,
  inputPolicyMode: InputPolicyMode,
): Promise<boolean> {
  // 状态不可用属于错误，而非维护响应；绝不掩盖失败的事务。
  const maintenance = await readMaintenance(tx);
  if (maintenance.mode !== 'open') {
    await updateRoom(tx, roomId, { error: '服务器维护中，暂不开始新对局。' });
    return false;
  }
  const inputMode = inputPolicyMode;
  if (inputMode !== 'observe' && inputMode !== 'enforce') {
    console.error({ event: 'input_policy_config_invalid', roomId });
    await updateRoom(tx, roomId, { error: '施法规则配置异常，暂不能开始新对局。' });
    return false;
  }
  // 单个临界区拥有整个开始过程：清理陈旧席位、就绪统计以及锁定对局要么一起提交，要么完全不提交，
  // 从而确保回滚的开始操作绝不会留下清理了一半的花名册。
  await deleteReservedSeats(tx, roomId);
  if ((await countPlayers(tx, roomId)) < MIN_PLAYERS) {
    await updateRoom(tx, roomId, { error: '至少需要 2 名已连接玩家才能开始。' });
    return false;
  }
  const ghost =
    room.opponent_kind === 'ghost' && room.ghost_id !== null
      ? await getGhost(tx, room.ghost_id)
      : null;
  if (room.opponent_kind === 'ghost' && ghost === null) throw new Error('room:missing_ghost');
  await resetPlayersForMatch(tx, roomId);
  await clearVolley(tx, roomId);
  const generationSeq = room.generation_seq + 1;
  const matchId = crypto.randomUUID();
  await updateRoom(tx, roomId, {
    phase: ghost ? 'countdown' : 'generating',
    deadline: ghost ? Date.now() + OPENING_COUNTDOWN_MS : 0,
    started_at: null,
    ended_at: null,
    end_reason: null,
    match_id: matchId,
    spell_book: ghost ? JSON.stringify(ghost.book) : null,
    opponent_next_at: null,
    events_json: '[]',
    event_seq: 0,
    error: null,
    locked: 1,
    generation_seq: generationSeq,
    generation_token: ghost ? null : `${matchId}:${generationSeq}`,
    generation_claim: null,
    reservation_state: 'locked',
    reservation_expires_at: null,
    input_policy_version: INPUT_POLICY_VERSION,
    input_policy_mode: inputMode,
    input_min_ms_per_code_point: INPUT_MIN_MS_PER_CODE_POINT,
  });
  return true;
}

/**
 * 当所有真人玩家席位均在线时，快速对局自动开始；虚拟席位不需要套接字连接。
 * 已发布的预留维持其自身的计时 —— 即使在服务器排空期间，已发布的预留仍可被加入和读取，
 * 并且只要全局准入重新开放，它就会立即开始，直到其 TTL 到期。
 */
export async function maybeAutoStartTx(
  tx: Transaction,
  roomId: string,
  registry: SocketRegistry,
  room: RoomRow,
  inputPolicyMode: InputPolicyMode,
): Promise<boolean> {
  if (room.mode !== 'quick' || room.phase !== 'lobby' || room.locked !== 0) return false;
  if (!reservationIsLive(room, Date.now())) return false;
  const players = await listPlayers(tx, roomId);
  if (players.length !== MAX_QUICK_PLAYERS) return false;
  const online = onlineUserIds(players, await currentConns(tx, roomId, registry));
  if (!players.every((row) => participantKind(room, row) !== 'human' || online.has(row.user_id)))
    return false;
  return startMatchTx(tx, roomId, room, inputPolicyMode);
}

/**
 * 仅在调用方的事务内对比赛进行一次严格的终局结算 ——
 * 冻结的打字速度、每位玩家的历史记录行以及停止所有输入的对局阶段要么一起提交，要么完全不提交。
 * 存储失败将使对局保持运行状态而非半结算状态：没有结算结果就没有打字速度，没有终局就没有历史结果，
 * 且持久化的施法意图仍是尚未应用的任何窗口的恢复来源。
 *
 * `endedAt` 具有权威性，而非依赖（可能发生延迟的）定时器：取最后一名对手被击倒的瞬间或比赛截止时间。
 * 结算后的比赛绝不再接受任何输入，并且每位玩家的打字速度在其各自完赛时冻结 ——
 * 时钟到期的胜者并非唯一停止计时的玩家。
 */
export async function finishMatchTx(
  tx: Transaction,
  roomId: string,
  reason: EndReason,
  endedAt: number,
): Promise<void> {
  const room = await getRoom(tx, roomId);
  if (!room || room.phase !== 'playing' || room.match_id === null) return;
  // 所有已接受的施法必须全部落地生效，结算结果才能变为不可变。
  if (await readVolley(tx, roomId)) throw new Error('room:unsettled_volley');
  if (!roomPolicyValid(room)) {
    reportGateStateInvalid(room);
    throw new Error('input_gate_state_invalid');
  }
  const matchId = room.match_id;
  const players = await listPlayers(tx, roomId);
  const startedAt = room.started_at ?? endedAt;
  const durationMs = Math.max(0, endedAt - startedAt);

  const speed = new Map<string, number>();
  for (const row of players) {
    const activeEnd = row.eliminated_at !== null ? Math.min(row.eliminated_at, endedAt) : endedAt;
    speed.set(
      row.user_id,
      cpmOf(row.correct_chars + row.progress, Math.max(0, (activeEnd - startedAt) / 1_000)),
    );
  }
  for (const row of players) {
    await updatePlayer(tx, roomId, row.user_id, { cpm: speed.get(row.user_id) ?? 0 });
  }

  const endReason = terminalReason(room, players, reason, endedAt);
  const ranks = matchRanks({ ...room, end_reason: endReason }, players);
  const rows: ResultInsert[] = players
    .filter((row) => participantKind(room, row) === 'human')
    .map((row) => ({
      match_id: matchId,
      user_id: row.user_id,
      room_id: roomId,
      theme: room.theme,
      opponent_kind: room.opponent_kind,
      damage_dealt: row.damage_dealt,
      hp_remaining: row.hp,
      spells_cast: row.spells_cast,
      correct_chars: row.correct_chars,
      duration_ms: durationMs,
      rank: ranks.get(row.user_id) ?? players.length,
      cpm: speed.get(row.user_id) ?? 0,
      accuracy: accuracyOf(row.attempt_total, row.error_total),
      input_policy_version: room.input_policy_version!,
      input_policy_mode: room.input_policy_mode,
      input_gate_hits: row.input_gate_hits,
      input_recoveries: row.input_recoveries,
      input_min_completion_ratio: row.input_min_completion_ratio,
      input_overloads: row.input_overloads,
      input_recovered_completions: row.input_recovered_completions,
      input_recovery_departures: row.input_recovery_departures,
      created_at: Date.now(),
    }));
  await insertResults(tx, rows);
  await publishGhostsTx(tx, room, players);

  // 配额由已完结的比赛消耗：排队凭证可以直接丢弃，而无需等待一个绝不再可游玩的房间。
  // 该事务提交的瞬间 `saved` 即为最终真实状态 —— 没有待排空的发件箱，也没有单独的重试保存步骤。
  await updateRoom(tx, roomId, {
    phase: 'finished',
    deadline: 0,
    ended_at: endedAt,
    end_reason: endReason,
    opponent_next_at: null,
    reservation_state: 'none',
    reservation_expires_at: null,
    persistence: 'saved',
    persist_retry_at: null,
    persist_attempts: 0,
  });
}
