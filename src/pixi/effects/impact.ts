import { Container, type Texture } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';
import type { SparkPool } from '../particles';
import { emitImpactShards } from './particles';
import { IMPACT_SLOTS, IMPACT_STYLES } from './styles';
import { configureExtras, createImpactSlot, updateExtras, type ImpactSlot } from './impact-slots';
import type { FxTextures } from './shapes';

export class Impacts {
  readonly view = new Container();

  private readonly textures: FxTextures;
  private readonly pools: Record<Element, SparkPool>;
  private readonly seed: () => number;
  private readonly slots: ImpactSlot[] = [];
  /** Caps impact brightness further when the page asked for gentler motion. */
  private safeFlash: boolean;

  constructor(
    textures: FxTextures,
    pools: Record<Element, SparkPool>,
    seed: () => number,
    safeFlash: boolean,
  ) {
    this.textures = textures;
    this.pools = pools;
    this.seed = seed;
    this.safeFlash = safeFlash;
    for (let index = 0; index < IMPACT_SLOTS; index += 1) {
      const slot = createImpactSlot(textures);
      this.slots.push(slot);
      this.view.addChild(slot.view);
    }
  }

  /**
   * One hit's ring, flash, element shapes and shards. The ground shockwave and
   * the damage float are separate transients the layer composes around this.
   */
  burst(
    x: number,
    y: number,
    element: Element,
    strength: number,
    artTexture: Texture | null,
    /** Sprite scale that makes the art the size the stage wants, at rest. */
    artBaseScale: number,
  ): void {
    const style = IMPACT_STYLES[element];
    const color = ELEMENT_COLORS[element];
    const core = ELEMENT_CORE[element];
    const strengthScale = 0.75 + Math.min(1, Math.max(0, strength)) * 0.45;

    const slot = this.takeSlot();
    slot.active = true;
    slot.hold = false;
    slot.spin = 0;
    slot.ringAspect = 1;
    slot.flashAspect = 1;
    slot.element = element;
    slot.strength = strength;
    slot.elapsed = 0;
    slot.duration = 620;
    slot.view.visible = true;
    slot.view.position.set(x, y);
    slot.ring.texture = this.textures.ring;
    slot.ring.blendMode = 'add';
    slot.ring.tint = style.ringTint;
    slot.ring.scale.set(0.6);
    slot.ring.alpha = 1;
    slot.flash.tint = element === 'fire' ? core : color;
    slot.flash.scale.set(style.flashScale * strengthScale * 0.5);
    slot.flash.alpha = 0;

    if (artTexture) {
      slot.art.texture = artTexture;
      slot.art.tint = 0xffffff;
      slot.art.visible = true;
      slot.art.alpha = 0.95;
      slot.art.rotation = 0;
      slot.artBaseScale = artBaseScale;
      slot.art.scale.set(artBaseScale * 0.55 * strengthScale);
    } else {
      slot.art.visible = false;
    }

    configureExtras(slot, style, strengthScale, this.textures);

    emitImpactShards(this.pools[element], style, x, y, element, strength, strengthScale, this.seed);
  }

  /**
   * The eliminated fighter's collapse: one big ring and flash, with the extras
   * left hidden. The layer adds the ground shockwave and the spark column.
   */
  eliminate(x: number, y: number, element: Element): void {
    const color = ELEMENT_COLORS[element];
    const core = ELEMENT_CORE[element];

    const slot = this.takeSlot();
    slot.active = true;
    slot.hold = false;
    slot.spin = 0;
    slot.ringAspect = 1;
    slot.flashAspect = 1;
    slot.element = element;
    slot.strength = 1.4;
    slot.elapsed = 0;
    slot.duration = 900;
    slot.view.visible = true;
    slot.view.position.set(x, y);
    slot.ring.texture = this.textures.ring;
    slot.ring.blendMode = 'add';
    slot.ring.tint = core;
    slot.ring.scale.set(0.8);
    slot.ring.alpha = 0.9;
    slot.flash.tint = color;
    slot.flash.scale.set(5);
    slot.flash.alpha = 0;
    slot.art.visible = false;
    for (const extra of slot.extras) extra.sprite.visible = false;
  }

  /**
   * Rank-1 flourish, held in place: a golden seal on the floor under the winner
   * and a rune crown over their head. Everything is a crisp stroked shape,
   * because soft additive light disappears against the bright arena sky.
   */
  hold(
    x: number,
    y: number,
    ringTexture: Texture,
    tint: number,
    spin: number,
    ringAspect: number,
    baseScale: number,
    ringAlpha: number,
    flashTint: number,
    flashScale: number,
    duration: number,
  ): void {
    const slot = this.takeSlot();
    slot.active = true;
    slot.hold = true;
    slot.spin = spin;
    slot.element = 'arcane';
    slot.strength = 1;
    slot.elapsed = 0;
    slot.duration = duration;
    slot.ringAspect = ringAspect;
    slot.flashAspect = 1;
    slot.baseScale = baseScale;
    slot.view.visible = true;
    slot.view.position.set(x, y);
    slot.ring.texture = ringTexture;
    slot.ring.blendMode = 'add';
    slot.ring.tint = tint;
    slot.ring.scale.set(baseScale, baseScale * ringAspect);
    slot.ring.alpha = ringAlpha;
    slot.flash.tint = flashTint;
    slot.flash.scale.set(flashScale, flashScale);
    slot.flash.alpha = 0;
    slot.art.visible = false;
    for (const extra of slot.extras) extra.sprite.visible = false;
  }

  /**
   * Live `prefers-reduced-motion` change: from the next spawn on, impact flashes
   * are capped the same way they are for a match started in reduced motion.
   */
  setReducedMotion(reduced: boolean): void {
    this.safeFlash = reduced;
  }

  update(deltaMS: number): void {
    for (const slot of this.slots) {
      if (!slot.active) continue;
      slot.elapsed += deltaMS;
      const progress = Math.min(1, slot.elapsed / slot.duration);
      const style = IMPACT_STYLES[slot.element];
      const eased = 1 - (1 - progress) * (1 - progress);

      if (slot.hold) {
        // A seal turning slowly in place instead of bursting outwards.
        const scale = slot.baseScale * (0.94 + eased * 0.16);
        slot.ring.scale.set(scale, scale * slot.ringAspect);
        slot.ring.rotation += slot.spin * deltaMS;
        slot.ring.alpha = (slot.baseScale > 1.5 ? 0.85 : 0.9) * (1 - progress * 0.85);
        slot.flash.alpha = Math.max(0, 0.24 * (1 - progress));
        const flashScale = (slot.baseScale > 1.5 ? 2.2 : 1.4) + eased * 0.5;
        slot.flash.scale.set(flashScale, flashScale * slot.flashAspect);
        if (progress >= 1) {
          slot.active = false;
          slot.view.visible = false;
        }
        continue;
      }

      const scale = 0.6 + style.ringScale * eased * (0.8 + slot.strength * 0.3);
      slot.ring.scale.set(scale, scale * slot.ringAspect);
      slot.ring.alpha = (1 - progress) * 0.95;

      if (progress < 0.22) {
        const peak = slot.flash.alpha;
        const wanted = (1 - progress / 0.22) * style.flashAlpha * (this.safeFlash ? 0.8 : 1);
        slot.flash.alpha = Math.max(peak, wanted);
      } else {
        slot.flash.alpha = Math.max(0, slot.flash.alpha - deltaMS / 180);
      }
      const flashScale = style.flashScale * (0.5 + eased * 1.1) * (0.8 + slot.strength * 0.3);
      slot.flash.scale.set(flashScale, flashScale * slot.flashAspect);

      if (slot.art.visible) {
        const artProgress = Math.min(1, progress / 0.62);
        const artScale =
          slot.artBaseScale * (0.55 + artProgress * 1.05) * (0.75 + slot.strength * 0.45);
        slot.art.scale.set(artScale);
        slot.art.rotation += deltaMS * (slot.element === 'arcane' ? 0.0012 : -0.0008);
        slot.art.alpha = (1 - artProgress) * 0.95;
      }

      updateExtras(slot, deltaMS);

      if (progress < 1) continue;
      slot.active = false;
      slot.view.visible = false;
    }
  }

  clear(): void {
    for (const slot of this.slots) {
      slot.active = false;
      slot.view.visible = false;
    }
  }

  private takeSlot(): ImpactSlot {
    for (let index = 0; index < this.slots.length; index += 1) {
      const slot = this.slots[index];
      if (!slot.active) return slot;
    }
    const recycled = this.slots.shift() as ImpactSlot;
    this.slots.push(recycled);
    return recycled;
  }
}
