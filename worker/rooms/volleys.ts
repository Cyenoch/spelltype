import type { CombatEvent } from '../../shared/protocol';
import { finishMatch } from './match';
import type { RoomScope } from './scope';
import { pushSnapshots } from './snapshots';
import { appendEvents } from './storage/events';
import { listPlayers, updatePlayer } from './storage/players';
import { getRoom } from './storage/room';
import { clearVolley, readVolley } from './storage/volley';

// LCM(1, 2, 3): every split in a 2–4 player room is an exact integer.
const HEALTH_SCALE = 6;

/** Applies a committed batch exactly once, with no await between damage and removal. */
export function resolveDueVolley(scope: RoomScope, now: number): boolean {
  const volley = readVolley(scope.sql);
  if (!volley || volley.endsAt > now) return false;
  const room = getRoom(scope.sql);
  if (!room || room.phase !== 'playing' || room.match_id !== volley.matchId) {
    clearVolley(scope.sql);
    return false;
  }
  const players = listPlayers(scope.sql);
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
      // Overkill is credited proportionally, never by arrival order or seat.
      // Departed targets have no outcome, so their share is discarded, not redirected.
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
  scope.transactionSync(() => {
    for (const player of players) {
      const result = outcomes.get(player.user_id);
      const damage = credited.get(player.user_id) ?? 0;
      if (!result && damage === 0) continue;
      updatePlayer(scope.sql, player.user_id, {
        hp: result?.hp ?? player.hp,
        eliminated_at: result?.eliminated ? volley.endsAt : player.eliminated_at,
        damage_dealt: player.damage_dealt + damage,
      });
    }
    appendEvents(scope.sql, events);
    clearVolley(scope.sql);
  });
  return true;
}

/** Shared clock boundary for alarms, inputs and departures; final-window casts precede timeout. */
export async function advanceCombat(scope: RoomScope, now: number): Promise<boolean> {
  const room = getRoom(scope.sql);
  if (!room || room.phase !== 'playing') return false;
  const pending = readVolley(scope.sql);
  if ((!pending || pending.endsAt > now) && now < room.deadline) return false;
  const resolved = resolveDueVolley(scope, now);
  const players = listPlayers(scope.sql);
  if (
    (!pending || resolved) &&
    players.filter((player) => player.eliminated_at === null).length <= 1
  ) {
    await finishMatch(
      scope,
      'elimination',
      resolved ? pending!.endsAt : Math.min(now, room.deadline),
    );
    return true;
  }
  if (room.deadline > 0 && now >= room.deadline) {
    await finishMatch(scope, 'timeout', room.deadline);
    return true;
  }
  if (resolved) pushSnapshots(scope);
  return resolved;
}
