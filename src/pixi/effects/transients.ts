import { Container, Sprite, Text } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import { formatAmount } from '../../ui/format';
import type { Element } from '../../../shared/protocol';
import { FLOAT_SLOTS, WAVE_SLOTS } from './styles';
import type { FxTextures } from './shapes';

/** The float container's largest scale over its life (`0.7 + eased * 0.45`). */
const FLOAT_MAX_SCALE = 1.15;
/** Generous line box for the monospace glyphs, as a factor of the font size. */
const FLOAT_LINE_BOX = 1.3;
/** Stroke width around the label; the painted outline extends past the glyphs. */
const FLOAT_STROKE_W = 5;

interface WaveSlot {
  sprite: Sprite;
  active: boolean;
  elapsed: number;
  duration: number;
  strength: number;
}

interface FloatSlot {
  view: Container;
  label: Text;
  active: boolean;
  elapsed: number;
  duration: number;
  drift: number;
  /** Canvas-local y the float's centre may not rise above. */
  ceil: number;
  /** Centre-to-top distance of the label at max scale; `ceil` bounds this edge. */
  halfExtent: number;
}

export class Transients {
  /** Ground rings; goes into the layer's `ground` container. */
  readonly waves = new Container();
  /** Damage numbers; goes into the layer's `air` container, above the pools. */
  readonly floats = new Container();

  private readonly waveSlots: WaveSlot[] = [];
  private readonly floatSlots: FloatSlot[] = [];

  constructor(textures: FxTextures) {
    for (let index = 0; index < FLOAT_SLOTS; index += 1) {
      const view = new Container();
      const glow = new Sprite(textures.glow);
      glow.anchor.set(0.5);
      glow.blendMode = 'add';
      glow.alpha = 0.35;
      const label = new Text({
        text: '',
        style: {
          fontFamily: 'SF Mono, JetBrains Mono, ui-monospace, monospace',
          fontSize: 28,
          fontWeight: '700',
          fill: 0xffffff,
          stroke: { color: 0x120d20, width: 5 },
        },
      });
      label.anchor.set(0.5);
      view.addChild(glow, label);
      view.visible = false;
      this.floats.addChild(view);
      this.floatSlots.push({
        view,
        label,
        active: false,
        elapsed: 0,
        duration: 1,
        drift: 0,
        ceil: 0,
        halfExtent: 0,
      });
    }
    for (let index = 0; index < WAVE_SLOTS; index += 1) {
      const sprite = new Sprite(textures.ring);
      sprite.anchor.set(0.5);
      sprite.blendMode = 'add';
      sprite.visible = false;
      this.waves.addChild(sprite);
      this.waveSlots.push({ sprite, active: false, elapsed: 0, duration: 1, strength: 1 });
    }
  }

  /** Expanding ground ring, used by hits and eliminations. */
  wave(x: number, y: number, tint: number, strength: number): void {
    const slot = this.takeWave();
    slot.active = true;
    slot.elapsed = 0;
    slot.duration = 520 + strength * 240;
    slot.strength = strength;
    slot.sprite.visible = true;
    slot.sprite.position.set(x, y);
    slot.sprite.tint = tint;
    slot.sprite.alpha = 0.75;
    slot.sprite.scale.set(0.4, 0.12);
    slot.sprite.rotation = 0;
  }

  /**
   * A floating damage number. `ceil` is the canvas-local y the label's top
   * edge may not cross — derived by the caller from the reserved top band, and
   * honoured including the label's growth in size — so even a max-strength
   * float's whole trajectory stays on the canvas below the DOM labels.
   */
  damageFloat(
    x: number,
    y: number,
    ceil: number,
    element: Element,
    damage: number,
    strength: number,
  ): void {
    // The float pool rotates: with every slot busy the oldest number is replaced
    // rather than a seventh one being created. Plain loops, not `.find` — this
    // runs per hit and a closure per call is an allocation.
    let slot = this.floatSlots[0];
    for (let index = 0; index < this.floatSlots.length; index += 1) {
      const candidate = this.floatSlots[index];
      if (!candidate.active) {
        slot = candidate;
        break;
      }
    }
    slot.active = true;
    slot.elapsed = 0;
    slot.duration = 950 + strength * 300;
    slot.drift = 0.026;
    slot.ceil = ceil;
    const fontSize = Math.round(26 + strength * 14);
    // The clamp bounds the label's painted top edge — glyphs, stroke and the
    // container's full scale-up — not its centre, so the whole number, not just
    // its middle, stays below the reserved band for the entire ascent.
    slot.halfExtent = Math.ceil((fontSize * FLOAT_LINE_BOX * FLOAT_MAX_SCALE) / 2) + FLOAT_STROKE_W;
    slot.view.visible = true;
    // Spawn inside the bounded lane too: the caller picks the chest lane, this
    // keeps a tiny body from pushing the start above the ceiling.
    slot.view.position.set(x, Math.max(ceil + slot.halfExtent, y));
    slot.view.alpha = 1;
    slot.label.text = `-${formatAmount(damage)}`;
    slot.label.style.fill = ELEMENT_CORE[element];
    slot.label.style.fontSize = fontSize;
    const glow = slot.view.children[0] as Sprite;
    glow.tint = ELEMENT_COLORS[element];
    glow.scale.set(1.6 + strength * 0.8);
  }

  update(deltaMS: number): void {
    for (const slot of this.waveSlots) {
      if (!slot.active) continue;
      slot.elapsed += deltaMS;
      const progress = Math.min(1, slot.elapsed / slot.duration);
      const eased = 1 - (1 - progress) * (1 - progress);
      const width = (1.2 + eased * 3.4) * (0.8 + slot.strength * 0.4);
      slot.sprite.scale.set(width, width * 0.3);
      slot.sprite.alpha = (1 - progress) * 0.7;
      if (progress < 1) continue;
      slot.active = false;
      slot.sprite.visible = false;
    }

    for (const slot of this.floatSlots) {
      if (!slot.active) continue;
      slot.elapsed += deltaMS;
      const progress = Math.min(1, slot.elapsed / slot.duration);
      const eased = 1 - (1 - progress) * (1 - progress);
      slot.view.y = Math.max(slot.ceil + slot.halfExtent, slot.view.y - deltaMS * slot.drift);
      slot.view.alpha = progress < 0.7 ? 1 : 1 - (progress - 0.7) / 0.3;
      slot.view.scale.set(0.7 + eased * 0.45);
      if (progress < 1) continue;
      slot.active = false;
      slot.view.visible = false;
    }
  }

  clear(): void {
    for (const slot of this.waveSlots) {
      slot.active = false;
      slot.sprite.visible = false;
    }
    for (const slot of this.floatSlots) {
      slot.active = false;
      slot.view.visible = false;
    }
  }

  private takeWave(): WaveSlot {
    for (let index = 0; index < this.waveSlots.length; index += 1) {
      const slot = this.waveSlots[index];
      if (!slot.active) return slot;
    }
    const recycled = this.waveSlots.shift() as WaveSlot;
    this.waveSlots.push(recycled);
    return recycled;
  }
}
