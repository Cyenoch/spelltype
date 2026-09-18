import type { Player, RoomSnapshot } from '../../../../shared/protocol';

export type CanvasState = 'pending' | 'ready' | 'failed';
export type RenderMode = 'canvas' | 'dom';

/** The health bands every combat surface colours by. */
export const LOW_HP_RATIO = 0.35;
export const CRITICAL_HP_RATIO = 0.15;

export interface CombatView {
  /** Seat order, as every combat surface draws it. */
  players: Player[];
  self: Player | undefined;
  /** Every seat the viewer's casts land on: all other living players, or none when down. */
  myTargets: Player[];
  /** Every living opponent whose casts land on the viewer — the same group, seen from the other side. */
  aimingAtMe: Player[];
}

/**
 * Who is fighting whom: the seat order, the viewer, and both targeting
 * directions. A cast always covers every other living player, so both sets are
 * "all alive but the viewer" — and empty once the viewer is down, because a
 * downed caster neither attacks nor draws fire.
 */
export function combatView(snapshot: RoomSnapshot, selfId: string): CombatView {
  const players = [...snapshot.players].sort((a, b) => a.slot - b.slot);
  const self = players.find((player) => player.id === selfId);
  const aliveOthers =
    self && self.eliminatedAt === null
      ? players.filter((player) => player.id !== self.id && player.eliminatedAt === null)
      : [];
  return { players, self, myTargets: aliveOthers, aimingAtMe: aliveOthers };
}

/**
 * Visual column order for every combat surface: the viewer stands leftmost,
 * the other seats follow in slot order. Presentation only — slots, targeting
 * and events keep their authoritative identities.
 */
export function visualSeatOrder(players: Player[], selfId: string): Player[] {
  const self = players.find((player) => player.id === selfId);
  if (!self) return [...players];
  return [self, ...players.filter((player) => player.id !== selfId)];
}

/** Stable arena index for a room: the same room always draws the same arena. */
export function arenaIndex(seed: string): number {
  let hash = 7;
  for (const char of seed) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1_000_003;
  return hash;
}
