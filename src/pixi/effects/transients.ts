import { Container, Sprite, Text } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';
import { FLOAT_SLOTS, WAVE_SLOTS } from './styles';
import type { FxTextures } from './shapes';

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
      this.floatSlots.push({ view, label, active: false, elapsed: 0, duration: 1, drift: 0 });
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

  damageFloat(x: number, y: number, element: Element, damage: number, strength: number): void {
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
    slot.view.visible = true;
    slot.view.position.set(x, y);
    slot.view.alpha = 1;
    slot.label.text = `-${damage}`;
    slot.label.style.fill = ELEMENT_CORE[element];
    slot.label.style.fontSize = Math.round(26 + strength * 14);
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
      slot.view.y -= deltaMS * slot.drift;
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
