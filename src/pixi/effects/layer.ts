import { Container, type Texture } from 'pixi.js';
import { ELEMENT_ORDER } from '../assets';
import { ELEMENT_COLORS } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';
import type { SparkPool } from '../particles';
import { Bolts, type BoltLanded } from './bolt';
import { Impacts } from './impact';
import { Transients } from './transients';
import {
  createJitter,
  emitEliminationBurst,
  emitTextMotes,
  emitTypingSpark,
  emitVictoryEmbers,
} from './particles';
import type { FxTextures } from './shapes';

/**
 * 弹道、命中、冲击波、打字火花与伤害飘字。
 *
 * 每个视觉元素都位于预分配的槽位中，因此即便一场对局有数百次命中，
 * 对局过程中也不会有任何分配，且该图层绝不会超出其容量上限。
 * 该图层是纯粹的呈现层：它从不决定伤害，只展示权威 `CombatEvent` 已经给出的结果。
 */
export class FxLayer {
  readonly ground = new Container();
  readonly air = new Container();

  private readonly textures: FxTextures;
  private readonly pools: Record<Element, SparkPool>;
  private readonly bolts: Bolts;
  private readonly impacts: Impacts;
  private readonly transients: Transients;
  /** 与各效果族共享，使每条随机化路径保持确定性。 */
  private readonly jitter: () => number;

  constructor(textures: FxTextures, pools: Record<Element, SparkPool>, safeFlash: boolean) {
    this.textures = textures;
    this.pools = pools;
    const jitter = createJitter();
    this.jitter = jitter;
    this.bolts = new Bolts(textures, pools, jitter);
    this.impacts = new Impacts(textures, pools, jitter, safeFlash);
    this.transients = new Transients(textures);

    this.ground.addChild(this.transients.waves);
    this.air.addChild(this.bolts.view, this.impacts.view);
    // 元素粒子池与空中图层的其余部分一样位于斗士上方，
    // 其容器在此处被加入，因此生成出的粒子确实会出现在画面上。
    for (const element of ELEMENT_ORDER) this.air.addChild(pools[element].view);
    this.air.addChild(this.transients.floats);
  }

  /** 由舞台设置一次；当弹道抵达目标时触发。 */
  set onLanded(handler: ((bolt: BoltLanded) => void) | null) {
    this.bolts.onLanded = handler;
  }

  get onLanded(): ((bolt: BoltLanded) => void) | null {
    return this.bolts.onLanded;
  }

  /** 开始一次弹道飞行。纯视觉表现；DOM 与规则层不受影响。 */
  launch(
    seq: number,
    attackerId: string,
    targetId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    element: Element,
    damage: number,
    eliminated: boolean,
    spellIndex: number,
  ): void {
    this.bolts.launch(
      seq,
      attackerId,
      targetId,
      fromX,
      fromY,
      toX,
      toY,
      element,
      damage,
      eliminated,
      spellIndex,
    );
  }

  /**
   * 单次命中的可见后续：地面冲击波、元素光环、闪光、元素形状、碎片与上浮的伤害数字。
   * `floatCeil` 限定数字的上浮上限（座位布局保留的顶部条带所决定的画布局部 y 坐标）。
   */
  impact(
    x: number,
    y: number,
    floatY: number,
    floatCeil: number,
    element: Element,
    strength: number,
    damage: number,
    artTexture: Texture | null,
    artBaseScale: number,
  ): void {
    this.impacts.burst(x, y, element, strength, artTexture, artBaseScale);
    this.transients.wave(x, y + 4, ELEMENT_COLORS[element], strength);
    this.transients.damageFloat(x, floatY, floatCeil, element, damage, strength);
  }

  /** 向外扩张的地面光环，供命中与淘汰使用。 */
  groundWave(x: number, y: number, tint: number, strength: number): void {
    this.transients.wave(x, y, tint, strength);
  }

  /** 被淘汰斗士的倒下：大光环、向上的火花柱与碎片。 */
  elimination(x: number, y: number, element: Element): void {
    this.transients.wave(x, y, ELEMENT_COLORS[element], 1.6);
    this.impacts.eliminate(x, y, element);
    emitEliminationBurst(this.pools[element], x, y, element);
  }

  /**
   * 对局结束时的第一名庆祝特效：地面上的金色印记、
   * 自获胜者头顶升起的符文冠冕，以及一圈余烬。
   * 全部使用清晰的描边形状，因为柔和的叠加光在明亮的竞技场天空下会完全消失。
   */
  victoryPillar(x: number, crownY: number, groundY: number, tint: number): void {
    this.impacts.hold(
      x,
      groundY,
      this.textures.rune.arcane,
      tint,
      0.0004,
      0.26,
      3.2,
      0.85,
      0xffe9b0,
      2.4,
      2600,
    );
    this.impacts.hold(
      x,
      crownY,
      this.textures.rune.fire,
      tint,
      -0.0012,
      1,
      1.5,
      0.9,
      0xfff2cf,
      1.6,
      2600,
    );
    emitVictoryEmbers(this.pools.arcane, x, groundY);
  }

  textMotes(x: number, element: Element, count: number): void {
    emitTextMotes(this.pools[element], x, element, count, this.jitter);
  }

  typingSpark(x: number, y: number, element: Element, amount: number): void {
    emitTypingSpark(this.pools[element], x, y, element, amount);
  }

  /** 推进所有存活中的效果。由舞台每帧调用一次。 */
  update(deltaMS: number): void {
    this.bolts.update(deltaMS);
    this.impacts.update(deltaMS);
    this.transients.update(deltaMS);
    for (const element of ELEMENT_ORDER) this.pools[element].update(deltaMS);
  }

  /** 当仍有弹道飞向该斗士时为 true。 */
  incomingFor(targetId: string): boolean {
    return this.bolts.incomingFor(targetId);
  }

  /** 当仍有任何弹道在飞行中时为 true，供减弱动效下的收尾判定使用。 */
  get airborne(): boolean {
    return this.bolts.airborne;
  }

  /**
   * 运行时切换 `prefers-reduced-motion`：自下一次生成起，
   * 命中闪光将按与「对局开始前即为减弱动效」相同的方式被压低。
   * 调用方自行清除飞行中的瞬时特效；此处不会改变任何已在途中的内容。
   */
  setReducedMotion(reduced: boolean): void {
    this.impacts.setReducedMotion(reduced);
  }

  clear(): void {
    this.bolts.clear();
    this.impacts.clear();
    this.transients.clear();
  }

  destroy(): void {
    this.onLanded = null;
    this.ground.destroy({ children: true });
    this.air.destroy({ children: true });
  }
}
