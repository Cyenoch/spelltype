import { Container, Sprite, type Texture } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';

/** Runes in the orbit; the accepted prefix lights them up one by one. */
const RUNE_COUNT = 8;
/** Progress past which the whole orbit reads as "about to land". Matches the DOM cast label's >=85% cue. */
const NEAR_READY = 0.85;
/** Orbit angular speed in rad/ms once runes are up; escalated near readiness. */
const SPIN = 0.0011;

interface RuneSlot {
  sprite: Sprite;
  /** Slot angle around the torso; the orbit rotates this around the ring. */
  slotAngle: number;
  radiusFactor: number;
  sizeFactor: number;
  baseAlpha: number;
}

/**
 * The caster's accumulating charge. Instead of a dial floating above the head —
 * which clipped off the canvas top on short arenas — the accepted prefix raises
 * an orbit of the fighter's own element runes around their torso, over a faint
 * chest halo: subtle at the first keystroke, a full fast ring near readiness.
 * The ring never rises above shoulder height, so faces, DOM name labels and the
 * health bar below the feet all stay clear.
 *
 * Everything is preallocated sprites of one shared rune texture: progress
 * changes flip visibility, alpha and scale; the ticker only moves transforms.
 * No per-frame allocation and no vector rebuild anywhere on the hot path.
 */
export class FighterCharge {
  readonly view = new Container();

  /** Halo plus runes; hidden entirely while nothing is accepted. */
  private readonly orbit = new Container();
  private readonly halo: Sprite;
  private readonly runes: RuneSlot[] = [];

  /** Orbit geometry in fighter-local px (feet at 0, up is negative). */
  private cy = 0;
  private rx = 30;
  private ry = 10;
  private runeSize = 12;

  private ratio = 0;
  private drawnRatio = -1;
  private angle = 0;
  private reduced = false;

  constructor(element: Element, runeTexture: Texture, glowTexture: Texture) {
    this.halo = new Sprite(glowTexture);
    this.halo.anchor.set(0.5);
    this.halo.blendMode = 'add';
    this.halo.tint = ELEMENT_COLORS[element];
    this.halo.alpha = 0;
    this.orbit.addChild(this.halo);

    for (let index = 0; index < RUNE_COUNT; index += 1) {
      const sprite = new Sprite(runeTexture);
      sprite.anchor.set(0.5);
      sprite.blendMode = 'add';
      sprite.tint = ELEMENT_CORE[element];
      sprite.visible = false;
      this.orbit.addChild(sprite);
      this.runes.push({
        sprite,
        slotAngle: (Math.PI * 2 * index) / RUNE_COUNT - Math.PI / 2,
        // Small per-rune variation so the ring reads as orbiting glyphs, not a
        // wireframe circle; deterministic, so every caster orbits the same way.
        radiusFactor: 0.88 + (index % 3) * 0.09,
        sizeFactor: 0.82 + (index % 2) * 0.18 + (index / RUNE_COUNT) * 0.14,
        baseAlpha: 0.8,
      });
    }

    this.orbit.visible = false;
    this.view.addChild(this.orbit);
  }

  /** Fits the orbit to the drawn body; the next paint is forced. */
  layout(box: { height: number; width: number }): void {
    this.view.scale.set(1, 1);
    this.view.position.set(0, 0);
    // Torso ring: centred at half the body height, never higher than the
    // shoulders — the one region of the character that is never a face.
    this.cy = -box.height * 0.5;
    this.rx = Math.max(box.width * 0.72, 30);
    this.ry = box.height * 0.22;
    this.runeSize = Math.max(10, Math.min(18, box.height * 0.1));
    this.halo.position.set(0, this.cy);
    const haloSize = Math.max(box.width * 1.5, box.height * 0.55);
    this.halo.width = haloSize;
    this.halo.height = haloSize;
    this.drawnRatio = -1;
  }

  /** Accepted typing ratio, 0..1. */
  accept(ratio: number): void {
    this.ratio = Math.max(0, Math.min(1, ratio));
  }

  /** Applies a freshly accepted ratio to the pooled sprites; no redraw. */
  paint(): void {
    if (Math.abs(this.ratio - this.drawnRatio) < 0.004) return;
    this.drawnRatio = this.ratio;

    const lit = this.ratio <= 0 ? 0 : Math.max(1, Math.round(this.ratio * RUNE_COUNT));
    const near = this.ratio >= NEAR_READY;
    this.orbit.visible = lit > 0;
    if (lit === 0) return;

    // Accumulation: each later rune sits a little brighter and larger than the
    // last, so the ring visibly grows towards readiness instead of popping in.
    for (let index = 0; index < RUNE_COUNT; index += 1) {
      const rune = this.runes[index];
      const on = index < lit;
      rune.sprite.visible = on;
      if (!on) continue;
      const ramp = (index + 1) / RUNE_COUNT;
      rune.baseAlpha = (0.55 + 0.45 * ramp) * (near ? 1 : 0.88);
    }
    this.halo.alpha = 0.05 + this.ratio * 0.1 + (near ? 0.12 : 0);
    this.place();
  }

  /** One frame of orbit. Reduced motion freezes the ring in place. */
  update(deltaMS: number): void {
    if (!this.orbit.visible) return;
    if (!this.reduced) {
      const near = this.ratio >= NEAR_READY;
      this.angle += deltaMS * SPIN * (near ? 1.9 : 1) * (0.6 + this.ratio * 0.7);
    }
    this.place();
  }

  /** Clears the charge: completion, defeat and a new match all start empty. */
  reset(): void {
    this.ratio = 0;
    this.drawnRatio = 0;
    this.orbit.visible = false;
    this.halo.alpha = 0;
  }

  /** Live `prefers-reduced-motion` change: the ring stops, accumulation stays. */
  setMotion(reduced: boolean): void {
    this.reduced = reduced;
  }

  /** Transforms only: positions, scales and depth-fades the lit runes. */
  private place(): void {
    for (const rune of this.runes) {
      if (!rune.sprite.visible) continue;
      const angle = this.angle + rune.slotAngle;
      // sin > 0 is the front of the ring: nearer to the viewer, so larger and
      // brighter; the back of the ring dims instead of drawing over the chest.
      const depth = (Math.sin(angle) + 1) / 2;
      rune.sprite.position.set(
        Math.cos(angle) * this.rx * rune.radiusFactor,
        this.cy + Math.sin(angle) * this.ry,
      );
      const size = this.runeSize * rune.sizeFactor * (0.85 + 0.3 * depth);
      rune.sprite.width = size;
      rune.sprite.height = size;
      rune.sprite.alpha = rune.baseAlpha * (0.72 + 0.28 * depth);
    }
  }
}
