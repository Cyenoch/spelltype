import type { CombatEvent } from '../../shared/protocol';
import { finishMatchTx } from './match';
import type { RoomScope } from './scope';
import { appendEvents } from './storage/events';
import { listPlayers, updatePlayer } from './storage/players';
import { getRoom } from './storage/room';
import { clearVolley, readVolley } from './storage/volley';
import type { RoomQuery } from './storage/query';
import { advanceOpponentTx } from './opponents';

// LCM(1, 2, 3)：2–4 人房间中的每一次分摊结果均为精确整数。
const HEALTH_SCALE = 6;

/**
 * 在调用方的事务内应用房间当前到期的批次：伤害、淘汰、击杀与伤害归属记账、
 * 事件批次以及齐射窗口的清除均一并提交 ——
 * 无法写入结果的结算绝不应抹除产生该结果的意图。
 * 返回是否实际应用了到期的齐射批次。
 */
export async function resolveDueVolleyTx(
  tx: RoomQuery,
  roomId: string,
  now: number,
): Promise<boolean> {
  const volley = await readVolley(tx, roomId);
  if (!volley || volley.endsAt > now) return false;
  const room = await getRoom(tx, roomId);
  if (!room || room.phase !== 'playing' || room.match_id !== volley.matchId) {
    // 遗留自已不存在的比赛窗口绝不能落地生效：将其清除。
    await clearVolley(tx, roomId);
    return false;
  }
  const players = await listPlayers(tx, roomId);
  const powerByCaster = new Map<string, number>();
  let totalPower = 0;
  for (const cast of volley.casts) {
    const units = cast.power * HEALTH_SCALE;
    totalPower += units;
    powerByCaster.set(cast.attackerId, (powerByCaster.get(cast.attackerId) ?? 0) + units);
  }
  const divisor = volley.roster.length - 1;
  const outcomes = new Map<string, { hp: number; fraction: number; eliminated: boolean }>();
  for (const player of players) {
    if (player.eliminated_at !== null || !volley.roster.includes(player.user_id)) continue;
    const incoming = (totalPower - (powerByCaster.get(player.user_id) ?? 0)) / divisor;
    if (incoming === 0) continue;
    const hpUnits = Math.round(player.hp * HEALTH_SCALE);
    const applied = Math.min(hpUnits, incoming);
    const hp = (hpUnits - applied) / HEALTH_SCALE;
    outcomes.set(player.user_id, { hp, fraction: applied / incoming, eliminated: hp === 0 });
  }

  const events: CombatEvent[] = [];
  const credited = new Map<string, number>();
  const markedKo = new Set<string>();
  let seq = room.event_seq;
  for (const cast of volley.casts) {
    const share = (cast.power * HEALTH_SCALE) / divisor;
    for (const [targetId, result] of outcomes) {
      if (targetId === cast.attackerId) continue;
      // 过量伤害按比例记账，绝不按到达先后或席位次序。
      // 已离开的目标没有结算结果，因此其分摊份额被丢弃而非重定向。
      const damage = (share * result.fraction) / HEALTH_SCALE;
      const eliminated = result.eliminated && !markedKo.has(targetId);
      if (eliminated) markedKo.add(targetId);
      credited.set(cast.attackerId, (credited.get(cast.attackerId) ?? 0) + damage);
      events.push({
        seq: ++seq,
        at: volley.endsAt,
        attackerId: cast.attackerId,
        targetId,
        element: cast.element,
        damage,
        targetHp: result.hp,
        spellIndex: cast.spellIndex,
        eliminated,
      });
    }
  }
  for (const player of players) {
    const result = outcomes.get(player.user_id);
    const damage = credited.get(player.user_id) ?? 0;
    if (!result && damage === 0) continue;
    await updatePlayer(tx, roomId, player.user_id, {
      hp: result?.hp ?? player.hp,
      eliminated_at: result?.eliminated ? volley.endsAt : player.eliminated_at,
      damage_dealt: player.damage_dealt + damage,
    });
  }
  await appendEvents(tx, roomId, events);
  await clearVolley(tx, roomId);
  return true;
}

/**
 * 推进最早到期的对手动作或战斗批次，当没有更早的待处理工作时，
 * 结算淘汰或原始截止时间。返回是否有所推进；
 * 输入和离开等调用方在接受更新的命令前会先排空到期工作。
 * 最终窗口的施法优先于超时落地生效。伤害、结果、终局状态和意图清除
 * 共享同一个受隔离保护的事务；快照和定时器紧随其后。
 */
export async function advanceCombat(scope: RoomScope, now: number): Promise<boolean> {
  const room = await getRoom(scope.db, scope.roomId);
  if (!room || room.phase !== 'playing') return false;
  const pending = await readVolley(scope.db, scope.roomId);
  const opponentDue =
    room.opponent_next_at !== null &&
    room.opponent_next_at < room.deadline &&
    room.opponent_next_at <= now;
  if ((!pending || pending.endsAt > now) && !opponentDue && now < room.deadline) return false;

  const progressed = await scope.transact(async (tx) => {
    const current = await getRoom(tx, scope.roomId);
    if (!current || current.phase !== 'playing') return false;
    const volley = await readVolley(tx, scope.roomId);
    // 窗口内的动作先于其结算；在窗口刚好结束的精确时刻，旧批次优先落地。
    if (
      current.opponent_next_at !== null &&
      current.opponent_next_at < current.deadline &&
      current.opponent_next_at <= now &&
      (!volley || current.opponent_next_at < volley.endsAt)
    ) {
      await advanceOpponentTx(tx, current, volley);
      return true;
    }
    const resolved = await resolveDueVolleyTx(tx, scope.roomId, now);
    const moreActionsDue =
      current.opponent_next_at !== null &&
      current.opponent_next_at < current.deadline &&
      current.opponent_next_at <= now;
    const players = await listPlayers(tx, scope.roomId);
    if (
      (!volley || resolved) &&
      players.filter((player) => player.eliminated_at === null).length <= 1
    ) {
      await finishMatchTx(
        tx,
        scope.roomId,
        'elimination',
        resolved && volley ? volley.endsAt : Math.min(now, current.deadline),
      );
      return true;
    }
    if (resolved && moreActionsDue) return true;
    if (current.deadline > 0 && now >= current.deadline) {
      await finishMatchTx(tx, scope.roomId, 'timeout', current.deadline);
      return true;
    }
    return resolved;
  });
  if (progressed) {
    await scope.push();
    await scope.arm();
  }
  return progressed;
}
