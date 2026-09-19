import { Container, Sprite } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';
import type { SparkPool } from '../particles';
import { emitBoltTrail } from './particles';
import { BOLT_SLOTS, BOLT_STYLES } from './styles';
import type { FxTextures } from './shapes';

export interface BoltLanded {
  seq: number;
  /** 发射时施法者的咒文游标，使命中美术与本次施法相对应。 */
  spellIndex: number;
  attackerId: string;
  targetId: string;
  element: Element;
  damage: number;
  eliminated: boolean;
  x: number;
  y: number;
}

type Point = { x: number; y: number };

interface BoltSlot {
  view: Container;
  core: Sprite;
  glow: Sprite;
  nodes: Float32Array;
  active: boolean;
  element: Element;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  elapsed: number;
  trailClock: number;
  spinPhase: number;
  seq: number;
  spellIndex: number;
  attackerId: string;
  targetId: string;
  damage: number;
  eliminated: boolean;
}

function createBoltSlot(textures: FxTextures): BoltSlot {
  const view = new Container();
  const glow = new Sprite(textures.glow);
  glow.anchor.set(0.5);
  glow.blendMode = 'add';
  const core = new Sprite(textures.bolt.arcane);
  core.anchor.set(0.5);
  core.blendMode = 'add';
  view.addChild(glow, core);
  view.visible = false;
  return {
    view,
    glow,
    core,
    nodes: new Float32Array(8),
    active: false,
    element: 'arcane',
    startX: 0,
    startY: 0,
    endX: 0,
    endY: 0,
    elapsed: 0,
    trailClock: 0,
    spinPhase: 0,
    seq: 0,
    spellIndex: 0,
    attackerId: '',
    targetId: '',
    damage: 0,
    eliminated: false,
  };
}

export class Bolts {
  readonly view = new Container();

  /** 由图层设置；当弹道抵达目标时触发。 */
  onLanded: ((bolt: BoltLanded) => void) | null = null;

  private readonly textures: FxTextures;
  private readonly pools: Record<Element, SparkPool>;
  private readonly seed: () => number;
  private readonly slots: BoltSlot[] = [];
  private readonly point: Point = { x: 0, y: 0 };
  private readonly lookahead: Point = { x: 0, y: 0 };

  constructor(textures: FxTextures, pools: Record<Element, SparkPool>, seed: () => number) {
    this.textures = textures;
    this.pools = pools;
    this.seed = seed;
    for (let index = 0; index < BOLT_SLOTS; index += 1) {
      const slot = createBoltSlot(textures);
      this.slots.push(slot);
      this.view.addChild(slot.view);
    }
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
    const slot = this.takeSlot();
    const style = BOLT_STYLES[element];
    slot.active = true;
    slot.element = element;
    slot.seq = seq;
    slot.spellIndex = spellIndex;
    slot.startX = fromX;
    slot.startY = fromY;
    slot.endX = toX;
    slot.endY = toY;
    slot.elapsed = 0;
    slot.trailClock = 0;
    slot.attackerId = attackerId;
    slot.targetId = targetId;
    slot.damage = damage;
    slot.eliminated = eliminated;

    slot.core.texture = this.textures.bolt[element];
    slot.core.tint = ELEMENT_CORE[element];
    slot.core.scale.set(style.coreScale);
    slot.glow.tint = ELEMENT_COLORS[element];
    slot.glow.scale.set(style.glowScale);

    const dx = toX - fromX;
    const dy = toY - fromY;
    slot.nodes[0] = fromX;
    slot.nodes[1] = fromY;
    slot.nodes[6] = toX;
    slot.nodes[7] = toY;
    if (style.path === 'zigzag') {
      const seed = this.seed();
      const jitter = 30 + (seed % 24);
      const sign = seed % 2 === 0 ? 1 : -1;
      slot.nodes[2] = fromX + dx * 0.36 - dy * 0.0008 * jitter * sign;
      slot.nodes[3] = fromY + dy * 0.36 + dx * 0.0008 * jitter * sign;
      slot.nodes[4] = fromX + dx * 0.68 + dy * 0.0008 * jitter;
      slot.nodes[5] = fromY + dy * 0.68 - dx * 0.0008 * jitter;
    }

    slot.view.visible = true;
    slot.view.alpha = 1;
    // 弹道的子元素由 `pathAt` 以竞技场绝对坐标定位，
    // 因此容器本身不能再叠加发射点偏移。
    slot.view.position.set(0, 0);
  }

  update(deltaMS: number): void {
    for (const slot of this.slots) {
      if (!slot.active) continue;
      const style = BOLT_STYLES[slot.element];
      slot.elapsed += deltaMS;
      const progress = Math.min(1, slot.elapsed / style.travel);
      this.pathAt(slot, progress, this.point);
      this.pathAt(slot, Math.min(1, progress + 0.04), this.lookahead);

      slot.core.position.set(this.point.x, this.point.y);
      slot.glow.position.set(this.point.x, this.point.y);
      slot.spinPhase += style.spin * deltaMS;
      slot.core.rotation =
        Math.atan2(this.lookahead.y - this.point.y, this.lookahead.x - this.point.x) +
        slot.spinPhase;
      const fade = 1 - Math.max(0, (progress - 0.86) / 0.14);
      slot.core.alpha = fade;
      slot.glow.alpha = 0.7 * fade;

      slot.trailClock += deltaMS;
      while (slot.trailClock >= style.trailEvery) {
        slot.trailClock -= style.trailEvery;
        emitBoltTrail(
          this.pools[slot.element],
          style,
          this.point.x,
          this.point.y,
          this.lookahead.x,
          this.lookahead.y,
          progress,
        );
      }

      if (progress < 1) continue;
      slot.active = false;
      slot.view.visible = false;
      this.onLanded?.({
        seq: slot.seq,
        spellIndex: slot.spellIndex,
        attackerId: slot.attackerId,
        targetId: slot.targetId,
        element: slot.element,
        damage: slot.damage,
        eliminated: slot.eliminated,
        x: slot.endX,
        y: slot.endY,
      });
    }
  }

  /** 当仍有弹道飞向该斗士时为 true。 */
  incomingFor(targetId: string): boolean {
    for (const slot of this.slots) {
      if (slot.active && slot.targetId === targetId) return true;
    }
    return false;
  }

  /** 当仍有任何弹道在飞行中时为 true，供减弱动效下的收尾判定使用。 */
  get airborne(): boolean {
    for (const slot of this.slots) {
      if (slot.active) return true;
    }
    return false;
  }

  clear(): void {
    for (const slot of this.slots) {
      slot.active = false;
      slot.view.visible = false;
    }
  }

  private pathAt(slot: BoltSlot, t: number, out: Point): void {
    const style = BOLT_STYLES[slot.element];
    if (style.path === 'zigzag') {
      const scaled = t * 3;
      const index = Math.min(2, Math.floor(scaled));
      const local = Math.min(1, scaled - index);
      const ax = slot.nodes[index * 2];
      const ay = slot.nodes[index * 2 + 1];
      const bx = slot.nodes[index * 2 + 2];
      const by = slot.nodes[index * 2 + 3];
      out.x = ax + (bx - ax) * local;
      out.y = ay + (by - ay) * local;
      return;
    }

    const dx = slot.endX - slot.startX;
    const dy = slot.endY - slot.startY;
    out.x = slot.startX + dx * t;
    out.y = slot.startY + dy * t;
    if (style.path === 'straight') return;

    const bow = style.hop * Math.sin(t * Math.PI) * (style.path === 'wave' ? Math.sin(t * 7) : 1);
    const length = Math.hypot(dx, dy) || 1;
    out.x += (-dy / length) * bow;
    out.y += (dx / length) * bow;
    // 下坠量在飞行中段达到峰值、两端归零，因此弹道弹丸仍能精确命中目标，
    // 而不会落在其下方。
    out.y += style.drop * t * (1 - t) * 4;
  }

  // 槽位拾取按索引扫描而非使用 `.find`：命中路径会多次调用它，
  // 每次调用创建一个一次性闭包就是热路径上的一次分配。
  private takeSlot(): BoltSlot {
    for (let index = 0; index < this.slots.length; index += 1) {
      const slot = this.slots[index];
      if (!slot.active) return slot;
    }
    const recycled = this.slots.shift() as BoltSlot;
    this.slots.push(recycled);
    return recycled;
  }
}
