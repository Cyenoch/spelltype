import { Container, Sprite } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';
import { EXTRAS_PER_IMPACT, type ImpactStyle } from './styles';
import type { FxTextures } from './shapes';

export interface ExtraSlot {
  sprite: Sprite;
  angle: number;
  distance: number;
  spin: number;
  scale: number;
  gravity: number;
  delay: number;
}

export interface ImpactSlot {
  view: Container;
  ring: Sprite;
  /** 来自资源注册表的生成式命中美术，若存在时使用。 */
  art: Sprite;
  flash: Sprite;
  extras: ExtraSlot[];
  active: boolean;
  /** 为 `true` 时是缓慢高耸的光柱（胜利），而非爆发式爆炸。 */
  hold: boolean;
  element: Element;
  strength: number;
  elapsed: number;
  duration: number;
  ringAspect: number;
  flashAspect: number;
  baseScale: number;
  /** 光环保持续期间每毫秒旋转的弧度数。 */
  spin: number;
  /** 命中美术处于静止尺寸时的精灵缩放。 */
  artBaseScale: number;
}

export function createImpactSlot(textures: FxTextures): ImpactSlot {
  const view = new Container();
  const ring = new Sprite(textures.ring);
  ring.anchor.set(0.5);
  ring.blendMode = 'add';
  const flash = new Sprite(textures.glow);
  flash.anchor.set(0.5);
  flash.blendMode = 'add';
  const art = new Sprite(textures.glow);
  art.anchor.set(0.5);
  art.blendMode = 'add';
  art.visible = false;
  view.addChild(ring, art, flash);
  const extras: ExtraSlot[] = [];
  for (let index = 0; index < EXTRAS_PER_IMPACT; index += 1) {
    const sprite = new Sprite(textures.shard.arcane);
    sprite.anchor.set(0.5);
    sprite.blendMode = 'add';
    sprite.visible = false;
    view.addChild(sprite);
    extras.push({ sprite, angle: 0, distance: 0, spin: 0, scale: 1, gravity: 0, delay: 0 });
  }
  view.visible = false;
  return {
    view,
    ring,
    art,
    flash,
    extras,
    active: false,
    hold: false,
    element: 'arcane',
    strength: 1,
    elapsed: 0,
    duration: 1,
    ringAspect: 1,
    flashAspect: 1,
    baseScale: 1,
    spin: 0,
    artBaseScale: 1,
  };
}

/** 将一次新爆发的三个元素附属效果沿各自样式方向向外摆放。 */
export function configureExtras(
  slot: ImpactSlot,
  style: ImpactStyle,
  strengthScale: number,
  textures: FxTextures,
): void {
  const element = slot.element;
  const color = ELEMENT_COLORS[element];
  const core = ELEMENT_CORE[element];
  const extras = style.extras;
  for (let index = 0; index < EXTRAS_PER_IMPACT; index += 1) {
    const extra = slot.extras[index];
    const spec = extras[index];
    extra.sprite.texture =
      style.extraTexture === 'spike' ? textures.spike : textures[style.extraTexture][element];
    extra.sprite.tint = index % 2 === 0 ? core : color;
    extra.angle = (spec[0] * Math.PI) / 180;
    extra.distance = spec[1] * strengthScale;
    extra.spin = spec[2];
    extra.scale = spec[3] * strengthScale;
    extra.gravity = spec[4];
    extra.delay = spec[5];
    extra.sprite.visible = true;
    extra.sprite.alpha = 1;
    extra.sprite.scale.set(extra.scale);
    extra.sprite.position.set(0, 0);
    extra.sprite.rotation = 0;
  }
}

/** 让一次进行中爆发的可见附属效果向外飞出并淡出。 */
export function updateExtras(slot: ImpactSlot, deltaMS: number): void {
  for (const extra of slot.extras) {
    if (!extra.sprite.visible) continue;
    const local = (slot.elapsed - extra.delay) / Math.max(1, slot.duration - extra.delay);
    if (local <= 0) {
      extra.sprite.alpha = 0;
      continue;
    }
    const clamped = Math.min(1, local);
    const out = 1 - (1 - clamped) * (1 - clamped);
    const distance = extra.distance * out;
    extra.sprite.position.set(
      Math.cos(extra.angle) * distance,
      Math.sin(extra.angle) * distance + extra.gravity * slot.elapsed * slot.elapsed * 0.001,
    );
    extra.sprite.rotation += extra.spin * deltaMS;
    const scale = extra.scale * (0.4 + out * 0.9);
    extra.sprite.scale.set(scale);
    extra.sprite.alpha = (1 - clamped) * 0.9;
  }
}
