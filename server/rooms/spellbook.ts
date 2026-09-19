import { OPENING_COUNTDOWN_MS } from '../../shared/protocol';
import type { GenerationOutcome } from '../generation/spells';
import { SEAT_TTL_MS } from './rules';
import type { RoomScope } from './scope';
import { pushSnapshots } from './snapshots';
import { currentConns, onlineUserIds, reconcileHost } from './sockets';
import { armLobbySeatExpiry, listPlayers } from './storage/players';
import { getRoom, updateRoom } from './storage/room';
import type { Transaction } from '../db';
import { participantKind } from './opponents';

/**
 * 当对局无法凑齐或初始化失败时，将房间恢复为开放大厅状态。
 * 此前的尝试可能在结算前被中断，或者大模型服务商调用失败：
 * 重新调用服务商可能会造成重复计费，因此直接坦白放弃本次对局。
 */
export async function abortMatch(scope: RoomScope, message: string): Promise<void> {
  await scope.transact(async (tx) => abortMatchInTx(tx, scope, message));
  await pushSnapshots(scope);
}

/** `abortMatch` 的事务内执行体；调用方持有该事务。 */
export async function abortMatchInTx(
  tx: Transaction,
  scope: RoomScope,
  message: string,
): Promise<void> {
  await updateRoom(tx, scope.roomId, {
    phase: 'lobby',
    deadline: 0,
    started_at: null,
    ended_at: null,
    end_reason: null,
    match_id: null,
    spell_book: null,
    events_json: '[]',
    event_seq: 0,
    locked: 0,
    error: message,
    generation_token: null,
    generation_claim: null,
    opponent_next_at: null,
    reservation_state: 'none',
    reservation_expires_at: null,
  });
  const roster = await listPlayers(tx, scope.roomId);
  const room = await getRoom(tx, scope.roomId);
  if (!room) throw new Error('room:not_found');
  const present = onlineUserIds(roster, await currentConns(tx, scope.roomId, scope.registry));
  for (const row of roster) if (participantKind(room, row) !== 'human') present.add(row.user_id);
  await armLobbySeatExpiry(tx, scope.roomId, [...present], Date.now() + SEAT_TTL_MS);
  await reconcileHost(tx, scope.roomId, scope.registry);
}

/**
 * 在全新的串行化命令中应用已完成的生成尝试结果。
 *
 * 此处会重新校验生成开始时捕获的 token，因此被替代的对局或尝试的响应
 * 绝不会覆盖更新的状态 —— 并且过期的响应绝不会触发另一次付费调用。
 * 单个共享法术书，单次开局倒计时：战斗截止时间由该倒计时结束时间推导得出，
 * 确保在战斗开始瞬间即被锁定固定。
 */
export async function applyGenerationOutcome(
  scope: RoomScope,
  token: string,
  outcome: GenerationOutcome,
): Promise<void> {
  await scope.transact(async (tx) => {
    const fresh = await getRoom(tx, scope.roomId);
    if (!fresh || fresh.phase !== 'generating' || fresh.generation_token !== token) return;

    if (!outcome.ok) {
      console.error('[room] generation failed', fresh.id, outcome.reason);
      await abortMatchInTx(tx, scope, outcome.message);
      return;
    }
    await updateRoom(tx, scope.roomId, {
      spell_book: JSON.stringify(outcome.spells),
      phase: 'countdown',
      started_at: null,
      deadline: Date.now() + OPENING_COUNTDOWN_MS,
      error: null,
      generation_token: null,
      generation_claim: null,
    });
  });
  await pushSnapshots(scope);
}
