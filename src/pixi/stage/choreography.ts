import type { Container } from 'pixi.js';
import type { Fighter } from '../fighter/fighter';
import type { FxLayer } from '../effects/layer';
import type { Seating } from './seating';
import type { Element, Player, RoomSnapshot } from '../../../shared/protocol';

/** Reduced motion lands the hit where it lands, then catches the effects up. */
const SETTLE_STEP_MS = 160;
/** A second confirm lands on the same frame; the completion pass waits it out. */
const SETTLE_HOLD_MS = 900;
const SETTLE_CATCH_UP_MS = 2400;

/** Everything the match-level beats read and drive. */
export interface ChoreographyDeps {
  /** Root of the arena scene graph; the shake moves it. */
  world: Container;
  /** Live screen rect, read for the countdown beat. */
  screen: { width: number; height: number };
  fighters: readonly Fighter[];
  seating: Seating;
  fx: FxLayer;
  /** Advances fx, fighters and glyphs by `deltaMS` outside the ticker. */
  frame: (deltaMS: number) => void;
  /** Renders one frame and counts it as a paint. */
  paint: () => void;
}

export interface Choreography {
  /** Screen-shake impulse; the frame update damps it away. */
  shake(amount: number): void;
  /** Shake damp, the countdown opening flourish and the victory beat for one frame. */
  update(
    deltaMS: number,
    phase: RoomSnapshot['phase'],
    occupancy: readonly (Player | null)[],
    element: Element,
  ): void;
  /** Drops the shake and recentres the world. */
  calm(): void;
  /** Reduced motion: paints the settled frame and schedules the completion pass. */
  settle(): void;
  /** Cancels a pending completion pass. */
  stopSettle(): void;
  reset(): void;
}

export function createChoreography(deps: ChoreographyDeps): Choreography {
  const { world, screen, fighters, seating, fx, frame, paint } = deps;
  let shakeLevel = 0;
  let victoryApplied = false;
  let openingPlayed = false;
  let settleTimer: number | null = null;

  return {
    shake(amount: number): void {
      shakeLevel = Math.max(shakeLevel, amount);
    },

    update(deltaMS, phase, occupancy, element): void {
      if (shakeLevel > 0) {
        shakeLevel = Math.max(0, shakeLevel - deltaMS * 0.022);
        world.position.set(
          (Math.random() - 0.5) * shakeLevel,
          (Math.random() - 0.5) * shakeLevel * 0.6,
        );
      } else if (world.position.x !== 0 || world.position.y !== 0) {
        world.position.set(0, 0);
      }

      if (phase === 'countdown' && !openingPlayed && occupancy.some((player) => player !== null)) {
        openingPlayed = true;
        const centreX = screen.width / 2;
        const centreY = screen.height * 0.9;
        fx.groundWave(centreX, centreY, 0x9f92ff, 1.3);
        fx.typingSpark(centreX, centreY - 40, element, 6);
        for (let slot = 0; slot < fighters.length; slot += 1) {
          if (occupancy[slot]) fighters[slot].flourish();
        }
      }

      if (phase !== 'finished' || victoryApplied) return;
      victoryApplied = true;
      const winner = occupancy.findIndex((player) => player !== null && player.rank === 1);
      for (let slot = 0; slot < fighters.length; slot += 1) {
        const player = occupancy[slot];
        if (!player) continue;
        const victorious = slot === winner;
        fighters[slot].setVictory(victorious);
        if (!victorious) continue;
        const seat = seating.geometry[slot];
        fx.victoryPillar(
          seat.x,
          Math.max(34, seat.feetY - seat.height - 18),
          seat.feetY - 18,
          0xffd79a,
        );
      }
    },

    calm(): void {
      shakeLevel = 0;
      world.position.set(0, 0);
    },

    settle(): void {
      frame(SETTLE_STEP_MS);
      paint();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        frame(SETTLE_CATCH_UP_MS);
        fx.clear();
        paint();
      }, SETTLE_HOLD_MS);
    },

    stopSettle(): void {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = null;
    },

    reset(): void {
      victoryApplied = false;
      openingPlayed = false;
    },
  };
}
