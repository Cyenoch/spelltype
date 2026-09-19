import { Container, Sprite, Text } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import { formatAmount } from '../../ui/format';
import type { Element } from '../../../shared/protocol';
import { FLOAT_SLOTS, WAVE_SLOTS } from './styles';
import type { FxTextures } from './shapes';

/** 飘字容器在其生命周期中的最大缩放（`0.7 + eased * 0.45`）。 */
const FLOAT_MAX_SCALE = 1.15;
/** 等宽字形的宽裕行框，以字号为倍数表示。 */
const FLOAT_LINE_BOX = 1.3;
/** 标签周围的描边宽度；绘制出的轮廓会超出字形范围。 */
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
  /** 飘字中心不得上升超过的画布局部 y 坐标。 */
  ceil: number;
  /** 标签在最大缩放下的中心到顶部距离；`ceil` 约束的正是这条上边缘。 */
  halfExtent: number;
}

export class Transients {
  /** 地面光环；放入图层的 `ground` 容器。 */
  readonly waves = new Container();
  /** 伤害数字；放入图层的 `air` 容器，位于各粒子池之上。 */
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

  /** 向外扩张的地面光环，供命中与淘汰使用。 */
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
   * 一个上浮的伤害数字。`ceil` 是标签上边缘不得越过的画布局部 y 坐标 ——
   * 由调用方依据保留的顶部条带推导，并计入标签放大后的尺寸 ——
   * 因此即便最大强度的飘字，其整条轨迹也始终位于 DOM 标签下方的画布之内。
   */
  damageFloat(
    x: number,
    y: number,
    ceil: number,
    element: Element,
    damage: number,
    strength: number,
  ): void {
    // 飘字池采用轮转：所有槽位都在使用时替换最旧的数字，
    // 而不是创建第七个。使用普通循环而非 `.find` ——
    // 它每次命中都会执行，而每次调用创建一个闭包就是一次分配。
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
    // 该约束限定的是标签绘制后的上边缘 —— 字形、描边以及容器的整体放大 ——
    // 而非其中心，因此整个数字（不只是其中部）在整个上升过程中都保持在保留条带之下。
    slot.halfExtent = Math.ceil((fontSize * FLOAT_LINE_BOX * FLOAT_MAX_SCALE) / 2) + FLOAT_STROKE_W;
    slot.view.visible = true;
    // 起点也落在受限通道之内：调用方选定胸口通道，
    // 这里确保身材矮小的个体不会把起点顶到上界之上。
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
