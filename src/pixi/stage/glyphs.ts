import { Sprite } from 'pixi.js';
import { ELEMENT_ORDER } from '../assets';
import { ELEMENT_CORE } from '../../ui/elements';
import type { Container } from 'pixi.js';
import type { FxTextures } from '../effects/shapes';
import type { StageAssets } from './assets';
import type { Element } from '../../../shared/protocol';

const GLYPH_SLOTS = 4;
/** 上升的字形火花在被隐藏之前的存活时长。 */
const GLYPH_LIFE_MS = 520;

interface GlyphSlot {
  sprite: Sprite;
  active: boolean;
  elapsed: number;
  drift: number;
}

/** 一次确认击键所抛出的元素字形火花。 */
export interface GlyphLayer {
  /** 在某个宿主坐标处抛出 `amount` 个字形火花。 */
  emit(element: Element, x: number, y: number, amount: number): void;
  /** 推进这些火花；一个结束的火花会归还其槽位。 */
  update(deltaMS: number): void;
}

export function createGlyphLayer(
  parent: Container,
  textures: FxTextures,
  assets: StageAssets,
): GlyphLayer {
  const slots: GlyphSlot[] = [];
  for (let index = 0; index < GLYPH_SLOTS; index += 1) {
    const sprite = new Sprite(assets.glyphs[0] ?? textures.shard.arcane);
    sprite.anchor.set(0.5);
    sprite.blendMode = 'add';
    sprite.visible = false;
    parent.addChild(sprite);
    slots.push({ sprite, active: false, elapsed: 0, drift: 0.05 + index * 0.01 });
  }

  return {
    emit(element: Element, x: number, y: number, amount: number): void {
      const texture = assets.glyphs[ELEMENT_ORDER.indexOf(element)] ?? textures.shard[element];
      for (let index = 0; index < amount; index += 1) {
        const slot = slots.find((candidate) => !candidate.active) ?? slots[0];
        slot.active = true;
        slot.elapsed = 0;
        slot.sprite.texture = texture;
        slot.sprite.tint = ELEMENT_CORE[element];
        slot.sprite.visible = true;
        slot.sprite.alpha = 0.9;
        slot.sprite.scale.set(0.5 + index * 0.06);
        slot.sprite.position.set(x + (index - 0.5) * 14, y);
      }
    },

    update(deltaMS: number): void {
      for (const slot of slots) {
        if (!slot.active) continue;
        slot.elapsed += deltaMS;
        const progress = Math.min(1, slot.elapsed / GLYPH_LIFE_MS);
        slot.sprite.y -= deltaMS * slot.drift;
        slot.sprite.alpha = (1 - progress) * 0.9;
        slot.sprite.rotation += deltaMS * 0.002;
        if (progress < 1) continue;
        slot.active = false;
        slot.sprite.visible = false;
      }
    },
  };
}
