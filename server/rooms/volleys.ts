import type { CombatEvent } from '../../shared/protocol';
import { finishMatchTx } from './match';
import type { RoomScope } from './scope';
import { appendEvents } from './storage/events';
import { listPlayers, updatePlayer } from './storage/players';
import { getRoom } from './storage/room';
import { clearVolley, readVolley } from './storage/volley';
import type { RoomQuery } from './storage/query';

// LCM(1, 2, 3): every split in a 2–4 player room is an exact integer.
const HEALTH_SCALE = 6;

/**
 * Applies the room's one due batch inside the caller's transaction: the damage, the
 * eliminations, the credit, the event batch and the volley's removal commit together —
 * a settlement that cannot write its results never erases the intent that produced it.
 * Returns whether a due volley was actually applied.
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
    // A window left over from a match that no longer exists can never land: drop it.
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
 * Shared clock boundary for alarms, inputs and departures: resolves the due
 * batch first, then settles a match that has no unfinished business left —
 * elimination when at most one seat survives, timeout at the original deadline.
 * Final-window casts land before the timeout does. Damage, results, terminal state
 * and intent removal share one fenced transaction; snapshots and timers follow.
 */
export async function advanceCombat(scope: RoomScope, now: number): Promise<boolean> {
  const room = await getRoom(scope.db, scope.roomId);
  if (!room || room.phase !== 'playing') return false;
  const pending = await readVolley(scope.db, scope.roomId);
  if ((!pending || pending.endsAt > now) && now < room.deadline) return false;

  const progressed = await scope.transact(async (tx) => {
    const current = await getRoom(tx, scope.roomId);
    if (!current || current.phase !== 'playing') return false;
    const volley = await readVolley(tx, scope.roomId);
    const resolved = await resolveDueVolleyTx(tx, scope.roomId, now);
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
