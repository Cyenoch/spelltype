import { Container, Graphics, Sprite } from 'pixi.js';
import { spellIconFor } from '../assets';
import { ELEMENT_COLORS } from '../../ui/elements';
import type { FxTextures } from '../effects/shapes';
import type { Seating } from './seating';
import type { StageAssets } from './assets';
import type { Element, Player, RoomSnapshot } from '../../../shared/protocol';

/** Motes drawn between the caster and its locked target. */
const AIM_MOTES = 4;

/** The targeting readout: the tether to the locked target and the caster's emblem. */
export interface AimLayer {
  /** The tether and the emblem; the stage places this in the scene graph. */
  readonly view: Container;
  /**
   * Redraws the tether; unchanged targeting short-circuits, and `force` bypasses
   * that check for callers that know the geometry moved.
   */
  drawAim(
    selfSlot: number,
    occupancy: readonly (Player | null)[],
    phase: RoomSnapshot['phase'],
    element: Element,
    force?: boolean,
  ): void;
  /** The caster's emblem: the spell sigil for the current cast, or the element rune. */
  drawEmblem(element: Element, index: number, phase: RoomSnapshot['phase'], selfSlot: number): void;
  /** Pulses the tether with the caster's charge while the match is live. */
  pulse(clock: number, progress: number, playing: boolean): void;
  /** Spins the emblem; a hidden emblem does not move. */
  spin(deltaMS: number): void;
  clear(): void;
}

/**
 * The room targets the next alive player clockwise from the caster's slot.
 * `-1` when the caster is not seated or has nobody left to hit.
 */
function aimSlot(selfSlot: number, occupancy: readonly (Player | null)[]): number {
  if (selfSlot < 0 || !occupancy[selfSlot]) return -1;
  for (let step = 1; step <= occupancy.length; step += 1) {
    const slot = (selfSlot + step) % occupancy.length;
    const player = occupancy[slot];
    if (player && player.eliminatedAt === null) return slot;
  }
  return -1;
}

export function createAimLayer(
  seating: Seating,
  textures: FxTextures,
  assets: StageAssets,
): AimLayer {
  const view = new Container();
  const tether = new Graphics();
  const emblem = new Sprite(textures.glow);
  emblem.anchor.set(0.5);
  emblem.blendMode = 'add';
  emblem.alpha = 0.42;
  emblem.visible = false;
  view.addChild(tether, emblem);

  const stance = { x: 0, y: 0 };
  const target = { x: 0, y: 0 };
  let signature = '';

  return {
    view,

    drawAim(selfSlot, occupancy, phase, element, force = false): void {
      const targetSlot = aimSlot(selfSlot, occupancy);
      const next = `${selfSlot}|${targetSlot}|${phase}|${element}`;
      if (!force && next === signature) return;
      signature = next;
      tether.clear();
      if (targetSlot < 0 || phase !== 'playing') return;
      seating.chest(selfSlot, stance);
      seating.chest(targetSlot, target);
      const color = ELEMENT_COLORS[element];
      const dx = target.x - stance.x;
      const dy = target.y - stance.y;
      const length = Math.hypot(dx, dy);
      if (length < 1) return;

      const targetY = seating.geometry[targetSlot].feetY - 2;
      // A few glowing motes rather than a rule: they fade with distance, so the
      // tether reads as magic drifting towards the locked target.
      for (let index = 0; index < AIM_MOTES; index += 1) {
        const at = (index + 1) / (AIM_MOTES + 1);
        const strength = 1 - at * 0.7;
        const x = stance.x + dx * at + Math.sin(index * 2.4) * 7;
        const y = stance.y + dy * at + Math.cos(index * 1.9) * 4;
        tether.circle(x, y, 4.5).fill({ color, alpha: 0.1 * strength });
        tether.circle(x, y, 1.9).fill({ color, alpha: 0.34 * strength });
      }

      // The lock marker owns the target's ground ring, so it reads as a deliberate
      // targeting reticle rather than a stray circle near their feet.
      tether.ellipse(target.x, targetY, 46, 15).stroke({ width: 2, color, alpha: 0.55 });
      tether.ellipse(target.x, targetY, 34, 11).stroke({ width: 1, color, alpha: 0.4 });
      for (let index = 0; index < 4; index += 1) {
        const angle = (Math.PI * 2 * index) / 4 + Math.PI / 4;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        tether
          .moveTo(target.x + cos * 40, targetY + sin * 13)
          .lineTo(target.x + cos * 54, targetY + sin * 18)
          .stroke({ width: 3, color, alpha: 0.5, cap: 'round' });
      }
    },

    drawEmblem(element, index, phase, selfSlot): void {
      const icon = assets.request(spellIconFor(element, index));
      if (icon) {
        emblem.texture = icon;
        emblem.tint = 0xffffff;
      } else {
        // The generated spell sigil is fetched on demand; until it lands (or if it
        // never does) the element rune stands in for it.
        emblem.texture = textures.rune[element];
        emblem.tint = ELEMENT_COLORS[element];
      }
      emblem.visible = phase === 'playing';
      if (selfSlot < 0) return;
      const seat = seating.geometry[selfSlot];
      if (!seat.present) return;
      // Behind the caster's own body, so it reads as a casting halo instead of a
      // wireframe drawn over their face.
      emblem.position.set(seat.x, seat.feetY - seat.height * 0.66);
      const size = seat.height * 0.42;
      emblem.width = size;
      emblem.height = size;
    },

    pulse(clock, progress, playing): void {
      if (playing) tether.alpha = 0.45 + Math.sin(clock / 700) * 0.18 + progress * 0.1;
    },

    spin(deltaMS): void {
      if (emblem.visible) emblem.rotation += deltaMS * 0.0005;
    },

    clear(): void {
      tether.clear();
      emblem.visible = false;
    },
  };
}
