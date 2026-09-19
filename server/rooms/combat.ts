import { normalizeSpellInput } from '../../shared/spell-input';
import { MAX_INPUT_CHARS, WS_CLOSE } from '../../shared/protocol';
import type { ClientMessage } from '../../shared/protocol';
import { charCount, diffSnapshot, inputCompletionRatio, spellAt } from '../scoring';
import { finishMatchTx } from './match';
import { INPUT_GATE_ERROR_MESSAGE, inputGateState, reportGateStateInvalid } from './input-gate';
import type { RoomScope } from './scope';
import type { SocketAuth } from './scope';
import { sendSnapshotTo } from './snapshots';
import { closeSocket, sendTo } from './sockets';
import { listPlayers, updatePlayer } from './storage/players';
import { getRoom } from './storage/room';
import { readSpellBook } from './storage/spell-book';
import { readVolley } from './storage/volley';
import type { RoomSocket } from '../contracts';
import { advanceCombat } from './volleys';
import type { Transaction } from '../db';
import { commitCastTx } from './casts';

/** 唯一接受的打字数据包：必须指明当前进行中的对局以及玩家当前的法术。 */
export type InputFrame = Extract<ClientMessage, { type: 'input' }>;

type InputOutcome =
  | 'retry'
  | 'ignored'
  | 'snapshot'
  | 'push'
  | 'arm'
  | { error: string; snapshot?: boolean; sessionExpired?: boolean };

/**
 * 单次权威的打字处理步骤。
 *
 * 输入配额在此调用前已扣除 —— `frames` 在确认所有权后立即对包括过期包在内的
 * 每个合法数据包扣除配额，并在超额时关闭连接。此处剩下的工作即裁决：
 * 优先处理到期的批次，然后重新识别席位（处理过程等待了事件循环，在此期间可能发生了
 * 替换、撤销或过期，过期的所有者既不读取也不入队任何内容），
 * 只有连贯的持久化状态才被允许响应此数据包。
 *
 * 唯一接受的施法完成必须指明当前对局、玩家当前法术索引和当前草稿世代（epoch），
 * 因此重复或过期的完成包 —— 源自重发的 WebSocket 帧、重连回放或多开标签页 ——
 * 将被完整丢弃，绝不会造成二次伤害。
 * 一次施法完成会在单个事务中提交其挂起的施法并推进法术光标。
 * 伤害与击倒（KO）稍后统一结算给整个 100ms 窗口，绝不只针对最早到达的输入，
 * 并且被强制限制门（enforce gate）拒绝的完成绝不会进入任何窗口。
 */
export async function handleInput(
  scope: RoomScope,
  socket: RoomSocket,
  meta: SocketAuth,
  message: InputFrame,
): Promise<void> {
  for (;;) {
    await advanceCombat(scope, Date.now());
    const outcome = await scope.transact((tx) => judge(scope, tx, socket, meta, message));
    if (outcome === 'retry') continue;
    // 在裁决事务提交之前，不会发生任何套接字或快照推送。
    if (typeof outcome === 'object') {
      sendTo(socket, { type: 'error', message: outcome.error });
      if (outcome.sessionExpired) closeSocket(socket, WS_CLOSE.sessionExpired, 'session expired');
      if (outcome.snapshot)
        await sendSnapshotTo(scope.db, scope.roomId, scope.registry, socket, meta);
    } else if (outcome === 'snapshot') {
      await sendSnapshotTo(scope.db, scope.roomId, scope.registry, socket, meta);
    } else if (outcome === 'push' || outcome === 'arm') {
      await scope.push();
      if (outcome === 'arm') await scope.arm();
    }
    return;
  }
}

/** 在与所有结果写操作相同的运行时/房间隔离隔离界限（fence）下执行读取与裁决。 */
async function judge(
  scope: RoomScope,
  tx: Transaction,
  socket: RoomSocket,
  meta: SocketAuth,
  message: InputFrame,
): Promise<InputOutcome> {
  const room = await getRoom(tx, scope.roomId);
  if (!room) return 'ignored';
  const players = await listPlayers(tx, scope.roomId);
  const pending = room.phase === 'playing' ? await readVolley(tx, scope.roomId) : null;
  // 此为接受时刻：锁获取与所有裁决读取均已完成。
  // 跨越边界的变动必须在裁决此数据包之前完成结算。
  const now = Date.now();
  if (
    room.phase === 'playing' &&
    (now >= room.deadline ||
      (pending !== null && pending.endsAt <= now) ||
      (room.opponent_next_at !== null && room.opponent_next_at <= now))
  )
    return 'retry';
  if (socket.readyState !== 1) return 'ignored';
  const self = players.find((row) => row.user_id === meta.userId);
  if (!self || self.conn_id !== meta.connId) return 'ignored';
  if (meta.sessionExpires <= now) {
    return { error: '登录状态已过期，请重新登录。', sessionExpired: true };
  }
  if (room.phase !== 'playing' || room.match_id === null) return 'snapshot';
  if (message.matchId !== room.match_id) {
    return { error: '比赛状态已更新，请以最新法术为准。', snapshot: true };
  }
  if (self.eliminated_at !== null || message.spellIndex !== self.spell_index) return 'snapshot';
  if (charCount(message.text) > MAX_INPUT_CHARS) return { error: '输入内容过长。' };
  const book = readSpellBook(room);
  const spell = spellAt(book, self.spell_index);
  if (!spell) {
    reportGateStateInvalid(room);
    return { error: INPUT_GATE_ERROR_MESSAGE, snapshot: true };
  }
  const spellLength = charCount(spell.text);
  const gate = inputGateState(room, self, spellLength);
  if (gate === null) {
    reportGateStateInvalid(room);
    return { error: INPUT_GATE_ERROR_MESSAGE, snapshot: true };
  }
  // 仅在已校验持久化门控状态之后，才会丢弃过期的草稿世代。
  if (message.draftEpoch !== self.draft_epoch) return 'snapshot';
  const text = normalizeSpellInput(message.text, spell.text);
  const delta = diffSnapshot(self.last_input, text, spell.text);
  const attemptTotal = self.attempt_total + delta.inserted;
  const errorTotal = self.error_total + delta.errors;

  if (text !== spell.text) {
    await updatePlayer(tx, scope.roomId, self.user_id, {
      progress: delta.progress,
      last_input: text,
      attempt_total: attemptTotal,
      error_total: errorTotal,
      input_reset_reason: text === self.last_input ? self.input_reset_reason : null,
    });
    return 'push';
  }

  if (players.every((row) => row.user_id === self.user_id || row.eliminated_at !== null)) {
    // 先前已接受的施法即使在目标离开后仍会生效命中。
    if (pending) return 'snapshot';
    await finishMatchTx(tx, scope.roomId, 'elimination', Math.min(now, room.deadline));
    return 'arm';
  }

  const tooEarly = now < gate.notBefore;
  const firstSample = self.input_sampled === 0;
  // inputGateState 已验证此时间戳连贯合法；绝不可凭空捏造回退值。
  const openedAt = self.input_opened_at!;
  const ratio = firstSample
    ? inputCompletionRatio(spellLength, openedAt, now, gate.minMsPerCodePoint)
    : self.input_min_completion_ratio;
  const gateHits = self.input_gate_hits + Number(firstSample && tooEarly);
  const minimumRatio =
    ratio === null
      ? self.input_min_completion_ratio
      : Math.min(self.input_min_completion_ratio ?? ratio, ratio);

  if (tooEarly && gate.mode === 'enforce') {
    await updatePlayer(tx, scope.roomId, self.user_id, {
      draft_epoch: self.draft_epoch + 1,
      input_reset_reason: 'completion_too_early',
      input_sampled: 1,
      input_gate_hits: gateHits,
      input_recoveries: self.input_recoveries + 1,
      input_min_completion_ratio: minimumRatio,
    });
    return 'push';
  }
  await commitCastTx(tx, room, self, players, book, pending, now);
  await updatePlayer(tx, scope.roomId, self.user_id, {
    attempt_total: attemptTotal,
    error_total: errorTotal,
    input_gate_hits: gateHits,
    input_min_completion_ratio: minimumRatio,
    input_recovered_completions: self.input_recovered_completions + Number(self.draft_epoch > 0),
  });
  return 'arm';
}
