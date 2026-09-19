import { Container, Sprite, type Texture } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';

/** 轨道上的符文数量；已被接受的前缀会逐个点亮它们。 */
const RUNE_COUNT = 8;
/** 超过该进度后，整条轨道读起来就是「即将命中」。与 DOM 施法标签的 >=85% 提示保持一致。 */
const NEAR_READY = 0.85;
/** 符文亮起后轨道的角速度，单位弧度/毫秒；接近就绪时会加速。 */
const SPIN = 0.0011;

interface RuneSlot {
  sprite: Sprite;
  /** 环绕躯干的槽位角度；轨道会将其绕环旋转。 */
  slotAngle: number;
  radiusFactor: number;
  sizeFactor: number;
  baseAlpha: number;
}

/**
 * 施法者不断累积的蓄力。这里不使用悬浮在头顶的刻度盘 ——
 * 那在矮赛场中会被画布顶部裁掉 —— 而是让已被接受的前缀在躯干周围
 * 升起一圈施法者本元素的符文轨道，叠加在一层淡淡的胸口光晕之上：
 * 第一次击键时若隐若现，接近就绪时则成为一圈完整而快速的环。
 * 该环绝不升到肩高之上，因此面部、DOM 名称标签以及脚下的生命条都保持清晰。
 *
 * 所有元素都是共享同一张符文纹理的预分配精灵：进度变化只翻转可见性、
 * 透明度与缩放；帧循环只移动变换。热路径上没有任何逐帧分配，也没有矢量重建。
 */
export class FighterCharge {
  readonly view = new Container();

  /** 光晕加符文；在没有任何被接受内容时整体隐藏。 */
  private readonly orbit = new Container();
  private readonly halo: Sprite;
  private readonly runes: RuneSlot[] = [];

  /** 轨道几何参数，单位斗士局部像素（脚部为 0，向上为负）。 */
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
        // 每个符文有微小差异，使这圈读起来像环绕飞行的符文，而不是一条线框圆；
        // 数值是确定性的，因此每个施法者的环绕方式都相同。
        radiusFactor: 0.88 + (index % 3) * 0.09,
        sizeFactor: 0.82 + (index % 2) * 0.18 + (index / RUNE_COUNT) * 0.14,
        baseAlpha: 0.8,
      });
    }

    this.orbit.visible = false;
    this.view.addChild(this.orbit);
  }

  /** 让轨道适配所绘制的身体；下一次绘制会被强制触发。 */
  layout(box: { height: number; width: number }): void {
    this.view.scale.set(1, 1);
    this.view.position.set(0, 0);
    // 躯干环：以身体高度的一半为中心，绝不高于肩部 ——
    // 那是角色身上唯一绝不会是面部的区域。
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

  /** 已接受的打字进度，0..1。 */
  accept(ratio: number): void {
    this.ratio = Math.max(0, Math.min(1, ratio));
  }

  /** 把刚接受的进度应用到池化精灵上；不做重绘。 */
  paint(): void {
    if (Math.abs(this.ratio - this.drawnRatio) < 0.004) return;
    this.drawnRatio = this.ratio;

    const lit = this.ratio <= 0 ? 0 : Math.max(1, Math.round(this.ratio * RUNE_COUNT));
    const near = this.ratio >= NEAR_READY;
    this.orbit.visible = lit > 0;
    if (lit === 0) return;

    // 累积感：越靠后的符文比前一个更亮、更大，
    // 因此这圈会明显朝就绪状态生长，而不是突然整体出现。
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

  /** 一帧的轨道演算。减弱动效下将环冻结在原位。 */
  update(deltaMS: number): void {
    if (!this.orbit.visible) return;
    if (!this.reduced) {
      const near = this.ratio >= NEAR_READY;
      this.angle += deltaMS * SPIN * (near ? 1.9 : 1) * (0.6 + this.ratio * 0.7);
    }
    this.place();
  }

  /** 清空蓄力：完成、失败与开启新对局都从空状态起步。 */
  reset(): void {
    this.ratio = 0;
    this.drawnRatio = 0;
    this.orbit.visible = false;
    this.halo.alpha = 0;
  }

  /** 运行时切换 `prefers-reduced-motion`：环停止转动，累积表现保留。 */
  setMotion(reduced: boolean): void {
    this.reduced = reduced;
  }

  /** 只做变换：定位、缩放并为点亮的符文做景深淡出。 */
  private place(): void {
    for (const rune of this.runes) {
      if (!rune.sprite.visible) continue;
      const angle = this.angle + rune.slotAngle;
      // sin > 0 表示环的前方：更靠近观察者，因此更大更亮；
      // 环的后方则变暗，而不是覆盖在胸口之上。
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
