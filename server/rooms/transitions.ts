import { WS_CLOSE, MATCH_DURATION_MS } from '../../shared/protocol';
import type { RoomScope } from './scope';
import { charCount, inputNotBefore, spellAt } from '../scoring';
import { finishMatchTx } from './match';
import { roomPolicyValid, reportGateStateInvalid } from './input-gate';
import { abortMatch } from './spellbook';
import { endReservation } from './reservation';
import { TIMED_PHASES } from './rules';
import { pushSnapshots } from './snapshots';
import { closeSocket, expiredSockets, reconcileHost, sendTo, unbindSeat } from './sockets';
import { expireSeats, listPlayers, updatePlayer } from './storage/players';
import { getRoom, updateRoom } from './storage/room';
import { readSpellBook } from './storage/spell-book';
import { advanceCombat } from './volleys';
import { initializeOpponentTx } from './opponents';

/** 单次到期流转处理的结果。 */
export interface AdvanceOutcome {
  progressed: boolean;
  /** 当认领了生成尝试时设置；引擎将在队列外继续执行该生成。 */
  generation?: string;
}

/**
 * 执行最多一个到期的阶段流转（或开启一个挂起的生成尝试）。
 * 截止时间来自持久化状态，因此延迟的追赶处理既不会延长也不会重开任何状态，
 * 并且绝不会重复计分。每个步骤提交各自的事务；
 * 调用方负责驱动追赶循环并广播快照。
 */
export async function advanceOnce(scope: RoomScope): Promise<AdvanceOutcome> {
  const room = await getRoom(scope.db, scope.roomId);
  if (!room) return { progressed: false };
  const now = scope.now();

  // 过期或被撤销的会话即使在房间空闲时也会失去连接（及其席位）。
  const expired = expiredSockets(scope.registry, now);
  if (expired.length > 0) {
    for (const { socket } of expired) {
      sendTo(socket, { type: 'error', message: '登录状态已过期，请重新登录。' });
      closeSocket(socket, WS_CLOSE.sessionExpired, 'session expired');
    }
    await scope.transact(async (tx) => {
      for (const { meta } of expired) await unbindSeat(tx, scope.roomId, meta, now);
      await reconcileHost(tx, scope.roomId, scope.registry);
    });
    await pushSnapshots(scope);
    return { progressed: true };
  }

  if (room.phase === 'generating' && room.generation_token !== null) {
    if (room.generation_claim === room.generation_token) {
      // 先前的尝试在结算前被中断。重新调用服务商会造成重复计费；
      // 此处直接坦白报错。当前引擎自身仍在等待的尝试不算中断：
      // 只有无活跃后续流程认领的 claim 才会走到放弃分支。
      if (scope.inFlightGeneration === room.generation_token) return { progressed: false };
      await abortMatch(scope, '出题中断，请重试。');
      return { progressed: true };
    }
    await scope.transact(async (tx) => {
      await updateRoom(tx, scope.roomId, { generation_claim: room.generation_token });
    });
    return { progressed: true, generation: room.generation_token };
  }

  // 到期的战斗批次在时钟结算比赛之前落地：最终窗口的施法优先于超时，
  // 且决出比赛胜负的齐射在此处终结比赛。
  if (room.phase === 'playing') {
    if (await advanceCombat(scope, now)) return { progressed: true };
  }

  if (TIMED_PHASES[room.phase] && room.deadline > 0 && now >= room.deadline) {
    if (room.phase === 'countdown') {
      await scope.transact(async (tx) => {
        // 在隔离界限内重新读取：并发流转绝不能重开已结算的对局，
        // 且战斗时钟推导自倒计时截止时间，因此延迟的追赶会平移整场比赛，
        // 而不是凭空赋予额外的比赛时间。
        const current = await getRoom(tx, scope.roomId);
        if (
          !current ||
          current.phase !== 'countdown' ||
          current.match_id !== room.match_id ||
          current.deadline !== room.deadline
        )
          return;
        // 战斗绝不能在从未锁定的策略下开始：裁决将没有任何依据来源可读。
        // 此属于状态损坏，而非缺少默认配置。
        if (!roomPolicyValid(current)) {
          reportGateStateInvalid(current);
          throw new Error('input_gate_state_invalid');
        }
        const openedAt = Date.now();
        const book = readSpellBook(current);
        const alive = (await listPlayers(tx, scope.roomId)).filter(
          (row) => row.eliminated_at === null,
        );
        const eligibility = alive.map((player) => {
          const spell = spellAt(book, player.spell_index);
          if (!spell) throw new Error('room:missing_spell');
          return {
            userId: player.user_id,
            notBefore: inputNotBefore(
              charCount(spell.text),
              openedAt,
              current.input_min_ms_per_code_point!,
            ),
          };
        });
        for (const entry of eligibility) {
          await updatePlayer(tx, scope.roomId, entry.userId, {
            input_opened_at: openedAt,
            input_not_before: entry.notBefore,
          });
        }
        await updateRoom(tx, scope.roomId, {
          phase: 'playing',
          started_at: room.deadline,
          deadline: room.deadline + MATCH_DURATION_MS,
        });
        await initializeOpponentTx(tx, {
          ...current,
          phase: 'playing',
          started_at: room.deadline,
          deadline: room.deadline + MATCH_DURATION_MS,
        });
      });
      // 战斗开始：在生成或倒计时期间认输的席位已出局，
      // 因此幸存者规则在此刻亦被校验 —— 对手已离开的决斗无需苦等时钟耗尽。
      // 若流转延迟过久以至于连对局窗口都已过去，则绝不发布可操作的进行中快照：
      // 提交进行中状态后，比赛立即依其原始截止时间结束 —— 没有攻击窗口，
      // 也没有任何人可操作的打字资格。
      if (Date.now() >= room.deadline + MATCH_DURATION_MS) {
        await scope.transact((tx) =>
          finishMatchTx(tx, scope.roomId, 'timeout', room.deadline + MATCH_DURATION_MS),
        );
        await pushSnapshots(scope);
        return { progressed: true };
      }
      const roster = await listPlayers(scope.db, scope.roomId);
      if (roster.filter((row) => row.eliminated_at === null).length <= 1) {
        await scope.transact((tx) => finishMatchTx(tx, scope.roomId, 'elimination', room.deadline));
        await pushSnapshots(scope);
        return { progressed: true };
      }
      await pushSnapshots(scope);
      return { progressed: true };
    }
  }

  if (
    room.mode === 'quick' &&
    room.reservation_state === 'reserved' &&
    room.reservation_expires_at !== null &&
    now >= room.reservation_expires_at
  ) {
    await endReservation(scope, 'expired', '匹配超时，请重新匹配。');
    return { progressed: true };
  }

  if (room.locked === 0 && room.phase === 'lobby') {
    let removed = 0;
    await scope.transact(async (tx) => {
      removed = await expireSeats(tx, scope.roomId, now);
      if (removed > 0) await reconcileHost(tx, scope.roomId, scope.registry);
    });
    if (removed > 0) {
      await pushSnapshots(scope);
      return { progressed: true };
    }
  }

  return { progressed: false };
}
