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
  /** The seat this player's casts land on, or null when nobody else is alive. */
  myTarget: number | null;
  aimingAtMe: Player[];
}

/** Who is fighting whom: the seat order, the viewer, and both targeting directions. */
export function combatView(snapshot: RoomSnapshot, selfId: string): CombatView {
  const players = [...snapshot.players].sort((a, b) => a.slot - b.slot);
  const self = players.find((player) => player.id === selfId);
  const capacity = snapshot.mode === 'quick' ? 2 : 4;
  const alive = players.filter((player) => player.eliminatedAt === null);
  const myTarget =
    self && self.eliminatedAt === null ? nextAliveSlot(alive, self.slot, capacity) : null;
  const aimingAtMe = self
    ? alive.filter(
        (player) =>
          player.id !== self.id && nextAliveSlot(alive, player.slot, capacity) === self.slot,
      )
    : [];
  return { players, self, myTarget, aimingAtMe };
}

/**
 * The next alive seat clockwise from `fromSlot`, mirroring the room's automatic
 * targeting. Returns `null` when nobody else is alive.
 */
function nextAliveSlot(players: Player[], fromSlot: number, capacity: number): number | null {
  const seats = capacity > 0 ? capacity : 4;
  for (let step = 1; step <= seats; step += 1) {
    const slot = (fromSlot + step) % seats;
    if (players.some((player) => player.slot === slot)) return slot;
  }
  return null;
}

/** Stable arena index for a room: the same room always draws the same arena. */
export function arenaIndex(seed: string): number {
  let hash = 7;
  for (const char of seed) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1_000_003;
  return hash;
}
