import { Container, Texture } from 'pixi.js';
import { ELEMENT_ORDER } from '../assets';
import type { Element } from '../../../shared/protocol';
import { FighterBar } from './bar';
import { FighterBody } from './body';
import { FighterCharge } from './charge';

export interface FighterState {
  slot: number;
  connected: boolean;
  self: boolean;
  /** 玩家最大生命值的 0..1 比例。 */
  hpRatio: number;
  eliminated: boolean;
  rank: number | null;
}

/** 斗士根节点的位置与其可用空间，单位宿主像素。 */
export interface FighterLayout {
  x: number;
  /** 斗士脚部的宿主 y 坐标。 */
  feetY: number;
  bodyHeight: number;
  maxWidth: number;
  /** 生命条在脚部下方多少像素处的局部 y 坐标。 */
  barOffsetY: number;
  /** 脚部下方剩余的垂直空间，供地面光池使用。 */
  baselineSpace: number;
}

/** 立绘适配完成后斗士实际占用的包围盒。 */
export interface FighterBox {
  height: number;
  width: number;
}

/** 单个斗士绘制所用的美术资源。剪影必须与 `body` 逐像素一致。 */
export interface FighterTextures {
  body: Texture;
  glow: Texture;
  ring: Texture;
  /**
   * 把身体立绘按其自身 Alpha 通道预先算成的纯白填充。KO 裹布与命中冲洗用的就是该形状，
   * 因此无需遮罩 —— 也就无需逐帧滤镜通道 —— 即可把平面填充裁切到角色范围内。
   */
  silhouette: Texture;
  /** 该斗士的元素符文，已预渲染；蓄力轨道会复用它。 */
  rune: Texture;
}

/**
 * 一名全身斗士：生成的立绘、元素光环、其本元素的地面光池，以及一条插值生命条，
 * 由三部分组装而成 —— 姿态身体、生命条与躯干蓄力轨道。
 *
 * 这两组的分工很关键。身体组（光环、立绘、地面）承担全部姿态 ——
 * 畏缩、倾覆、胜利 —— 而生命条与蓄力符文绝不旋转：
 * 会随主人一起倾斜的读数，恰恰在最需要它的时刻变得无法阅读。
 */
export class Fighter {
  readonly view = new Container();
  readonly slot: number;
  readonly element: Element;

  private readonly body: FighterBody;
  private readonly bar: FighterBar;
  private readonly charge: FighterCharge;

  private active = true;
  private eliminated = false;
  private koPending = false;

  constructor(
    slot: number,
    textures: FighterTextures,
    /** 生命条边框两端宝石的着色。 */
    flashTint: number,
  ) {
    this.slot = slot;
    this.element = ELEMENT_ORDER[slot % ELEMENT_ORDER.length];
    this.body = new FighterBody(textures, this.element, slot);
    this.bar = new FighterBar(this.element, flashTint);
    this.charge = new FighterCharge(this.element, textures.rune, textures.glow);
    this.view.addChild(this.body.view, this.bar.view, this.charge.view);
  }

  /** 当该斗士已倒下并退出对局时为 true。 */
  get isDown(): boolean {
    return this.eliminated;
  }

  get eliminationPending(): boolean {
    return this.koPending;
  }

  /** 隐藏本场对局没有占用者的席位。 */
  setActive(active: boolean): void {
    this.active = active;
    this.view.visible = active;
  }

  layout(layout: FighterLayout): FighterBox {
    const { x, feetY, bodyHeight, maxWidth, barOffsetY, baselineSpace } = layout;
    this.view.position.set(x, feetY);
    const box = this.body.layout(bodyHeight, maxWidth, baselineSpace);
    this.bar.layout(maxWidth, barOffsetY);
    this.charge.layout(box);
    this.paint();
    return box;
  }

  /** 应用权威状态。`instant` 会跳过追赶动画。 */
  applyState(state: FighterState, instant: boolean, deferElimination = false): void {
    const hp = Math.min(1, Math.max(0, state.hpRatio));
    const hit = this.bar.applyHealth(hp, instant);
    this.body.applyRoomState(state.connected, 1 - hp, hit);
    // 现在每个站立中的施法者都会显示自己的蓄力，而不只是本地观察者：
    // 符文采用各斗士自身的元素，因此无需知道咒文元素。
    this.charge.view.visible = !state.eliminated;
    this.view.visible = this.active;

    if (state.eliminated) {
      // 快照可能在造成致命一击的弹道尚未飞完时就先报出淘汰；
      // 这种情况下姿态会等待命中落地。
      if (deferElimination && !this.eliminated) {
        this.koPending = true;
      } else {
        this.koPending = false;
        this.applyEliminated(true, instant);
      }
    } else {
      this.koPending = false;
      this.applyEliminated(false, instant);
    }
    this.paint();
  }

  /** 在致命弹道落地后，立即播放此前被推迟的倒下动画。 */
  commitElimination(instant: boolean): void {
    if (!this.koPending) return;
    this.koPending = false;
    this.applyEliminated(true, instant);
  }

  private applyEliminated(eliminated: boolean, instant: boolean): void {
    if (eliminated === this.eliminated) return;
    this.eliminated = eliminated;
    if (!eliminated) {
      // 重新站起（复活、下一场对局）：在新的进度到来之前，
      // 轨道不得显示上一命的蓄力。
      this.charge.reset();
      this.body.stand();
      return;
    }
    this.charge.reset();
    this.charge.view.visible = false;
    this.body.collapse(instant);
  }

  hit(strength: number, direction: number): void {
    if (this.eliminated) return;
    this.body.hit(strength, direction);
  }

  /** 该斗士成功打出一次攻击时播放。 */
  flourish(): void {
    this.body.flourish();
  }

  setVictory(active: boolean): void {
    this.body.setVictory(active);
  }

  setCharge(ratio: number): void {
    this.charge.accept(ratio);
  }

  /** 运行时切换 `prefers-reduced-motion`：轨道冻结，累积表现保留。 */
  setMotion(reduced: boolean): void {
    this.charge.setMotion(reduced);
  }

  update(deltaMS: number, pulse: number): void {
    this.bar.catchUp(deltaMS);
    this.body.update(deltaMS, pulse, this.eliminated);
    this.charge.update(deltaMS);
    this.paint();
  }

  private paint(): void {
    this.bar.paint();
    if (!this.eliminated) this.charge.paint();
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
