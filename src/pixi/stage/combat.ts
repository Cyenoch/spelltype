import { combatFxFor } from '../assets';
import type { Fighter } from '../fighter/fighter';
import type { FxLayer } from '../effects/layer';
import type { Seating } from './seating';
import type { StageAssets } from './assets';
import type { CombatEvent, Element } from '../../../shared/protocol';
import { COMBAT_EVENT_RING_SIZE } from '../../../shared/protocol';

/** 容纳整个服务端事件环，使一次同时齐射绝不会部分溢出。 */
const QUEUE_LIMIT = COMBAT_EVENT_RING_SIZE;
/** 两个批次发射之间的间隔节奏，使各自独立的施法仍读作一次齐射。 */
const SPAWN_GAP_MS = 110;
/** 与同一目标上一次命中间隔如此之短即为重复命中，落地更轻。 */
const REPEAT_WINDOW_MS = 150;
/** 致命一击仍在飞行途中时，斗士最多可保持站立多久。 */
const DEFERRED_KO_MS = 1500;
/**
 * 伤害飘字走目标的上身通道，而不是悬在头顶：
 * 头顶空间属于保留给 DOM 标签的条带。两个边界都相对 `seating.topBand`，
 * 因此可以证明整条轨迹在任何席位、任何画布尺寸下都留在画布之内。
 * 位移余量覆盖了最坏情况的标签半高 —— 强度 1.35 时 45px 字号，
 * 放大到 1.15，再加上 5px 描边，约合中心之上 28px ——
 * 因此即便一个正在淡出的最大强度数字也绝不会探入该条带。
 */
const FLOAT_SPAWN_CLEARANCE = 56;
/** 漂移飘字中心的硬上限：条带边缘加上标签余量。 */
const FLOAT_TRAVEL_CLEARANCE = 30;

/** 将要落到某个目标上的一次命中，完全按照房间 `CombatEvent` 所描述的样子。 */
export type AttackOrder = {
  seq: number;
  attackerId: string;
  targetId: string;
  element: Element;
  damage: number;
  eliminated: boolean;
  spellIndex: number;
};

/** 带有其结算批次标记的 `AttackOrder`；共享同一个 `at` 的指令会同时发射。 */
export interface AttackOrderWithBatch extends AttackOrder {
  /** 该次施法结算批次的服务端时间戳。 */
  at: number;
}

/** 一次已结算命中所需的、对局级节拍。 */
export interface CombatBeats {
  /** 减弱动效：命中落在它该落的位置，随即收尾那一帧。 */
  settle(): void;
  /** 一次击杀值得一次屏幕震动冲量。 */
  shake(amount: number): void;
}

export interface Combat {
  /** 将一个战斗事件入队；减弱动效下就地结算。 */
  enqueue(event: CombatEvent, clock: number): void;
  /** 以固定节奏发射已入队的指令；每帧一次。 */
  spawn(deltaMS: number, clock: number): void;
  /** 一次性应用所有已入队指令，不做飞行（用于模式切换）。 */
  flush(clock: number): void;
  /** 一条弹道抵达了它的目标。 */
  resolve(order: AttackOrder, clock: number): void;
  /** 记录某席位是否正等待一次被推迟的淘汰。 */
  defer(slot: number, pending: boolean, clock: number): void;
  /** 提交已超过宽限期的被推迟淘汰。 */
  sweep(clock: number): void;
  /** 当针对该用户的攻击正在飞行或已入队时为 true。 */
  incoming(userId: string): boolean;
  reset(): void;
}

/** 攻击时序管理所读取和写入的全部内容。 */
export interface CombatWiring {
  host: HTMLElement;
  fighters: readonly Fighter[];
  /** 按用户 id 查席位，依据当前快照的入座结果。 */
  slotOf: (userId: string) => number | undefined;
  seating: Seating;
  fx: FxLayer;
  assets: StageAssets;
  beats: CombatBeats;
  /** 减弱动效下完全跳过弹道飞行。 */
  reduced: () => boolean;
}

export function createCombat(wiring: CombatWiring): Combat {
  const { host, fighters, slotOf, seating, fx, assets, beats, reduced } = wiring;
  const queue: AttackOrderWithBatch[] = [];
  /** 正等待一次尚未落地的致命一击的席位，按席位索引。 */
  const deferredKo = new Map<number, number>();
  const stance = { x: 0, y: 0 };
  const target = { x: 0, y: 0 };
  let spawnClock = 0;
  /** 每个目标席位最近一次命中时间，使同一受害者身上的快速追击落地更轻。 */
  const lastImpactAt = new Map<number, number>();
  let hitCount = 0;

  const applyImpact = (order: AttackOrder, instant: boolean, clock: number): void => {
    const targetSlot = slotOf(order.targetId);
    const attackerSlot = slotOf(order.attackerId);
    if (targetSlot === undefined) return;

    const seat = seating.geometry[targetSlot];
    const fighter = fighters[targetSlot];
    const base = Math.min(1, Math.max(0.35, order.damage / 64));
    // 减轻是按目标分别判定的：一次群体攻击中同时落下的多道伤害
    // 会在同一帧打到不同斗士身上并保留各自完整权重，
    // 而在时间窗内对同一受害者的真正追击则落地更轻。
    const repeated = clock - (lastImpactAt.get(targetSlot) ?? -1000) < REPEAT_WINDOW_MS;
    lastImpactAt.set(targetSlot, clock);
    const strength = repeated ? base * 0.7 : base;

    // 推开方向背离攻击者，使命中读起来有方向感。
    const attackerSeat = attackerSlot !== undefined ? seating.geometry[attackerSlot] : undefined;
    fighter.hit(strength, attackerSeat && attackerSeat.x > seat.x ? -1 : 1);
    // 倒下、冲击波与震动对每个目标恰好触发一次：对一名已倒下的斗士而言，
    // 第二个致命事件 —— 快照先结算了 KO，或同一批次中有两条记录指向同一受害者 ——
    // 绝不能将其重放。
    const koLands = order.eliminated && !fighter.isDown;
    if (koLands) fighter.commitElimination(reduced() || instant);
    if (attackerSlot !== undefined) fighters[attackerSlot].flourish();

    seating.chest(targetSlot, target);
    const art = assets.request(combatFxFor(order.element, order.spellIndex));
    // 数字从目标上身浮出 —— 走胸口通道，绝不悬在头顶高处从而爬进保留的标签条带 ——
    // 且其整段上升都被钳制在条带边缘。
    const floatCeil = seating.topBand + FLOAT_TRAVEL_CLEARANCE;
    const floatY = Math.max(
      seating.topBand + FLOAT_SPAWN_CLEARANCE,
      seat.feetY - seat.height * 0.74,
    );
    // 命中美术被归一化为斗士身高的一定比例，
    // 因此 256px 与 1024px 的纹理在屏幕上落地的尺寸相同。
    const artBaseScale = art ? (seat.height * 0.4) / Math.max(1, art.width) : 1;
    fx.impact(
      target.x,
      target.y,
      floatY,
      floatCeil,
      order.element,
      order.eliminated ? 1.35 : strength,
      order.damage,
      art,
      artBaseScale,
    );
    if (koLands) {
      fx.elimination(seat.x, seat.feetY - 6, order.element);
      if (!reduced()) beats.shake(5);
    }
    hitCount += 1;
    host.dataset.hits = String(hitCount);
    host.dataset.hitSeq = String(order.seq);
  };

  const resolve = (order: AttackOrder, clock: number): void => {
    applyImpact(order, false, clock);
    if (reduced()) beats.settle();
  };

  const launch = (order: AttackOrder, clock: number): void => {
    const attackerSlot = slotOf(order.attackerId);
    const targetSlot = slotOf(order.targetId);
    if (attackerSlot === undefined || targetSlot === undefined) return;
    if (reduced()) {
      // 减弱动效：不做弹道飞行，命中落在它该落的位置。
      resolve(order, clock);
      return;
    }
    seating.chest(attackerSlot, stance);
    seating.chest(targetSlot, target);
    fx.launch(
      order.seq,
      order.attackerId,
      order.targetId,
      stance.x,
      stance.y,
      target.x,
      target.y,
      order.element,
      order.damage,
      order.eliminated,
      order.spellIndex,
    );
  };

  return {
    enqueue(event: CombatEvent, clock: number): void {
      const order: AttackOrderWithBatch = {
        seq: event.seq,
        attackerId: event.attackerId,
        targetId: event.targetId,
        element: event.element,
        damage: event.damage,
        eliminated: event.eliminated,
        spellIndex: event.spellIndex,
        at: event.at,
      };
      if (reduced()) {
        resolve(order, clock);
        return;
      }
      if (queue.length >= QUEUE_LIMIT) {
        applyImpact(order, false, clock);
        return;
      }
      queue.push(order);
    },

    spawn(deltaMS: number, clock: number): void {
      spawnClock -= deltaMS;
      if (queue.length === 0 || spawnClock > 0) return;
      // 同一个权威结算批次在同一帧内发射：单次施法读起来像一次同时分摊到
      // 所有对手身上的齐射，而不是逐个命中的串行行军。下一批次会等满整个间隔。
      const batchAt = queue[0].at;
      while (queue.length > 0 && queue[0].at === batchAt) {
        const order = queue.shift();
        if (!order) break;
        launch(order, clock);
      }
      spawnClock = SPAWN_GAP_MS;
    },

    flush(clock: number): void {
      for (const order of queue) applyImpact(order, true, clock);
      queue.length = 0;
      spawnClock = 0;
    },

    resolve,

    defer(slot: number, pending: boolean, clock: number): void {
      if (pending) deferredKo.set(slot, clock);
      else deferredKo.delete(slot);
    },

    sweep(clock: number): void {
      for (const [slot, since] of deferredKo) {
        if (clock - since > DEFERRED_KO_MS) {
          deferredKo.delete(slot);
          fighters[slot].commitElimination(false);
        }
      }
    },

    incoming(userId: string): boolean {
      if (fx.incomingFor(userId)) return true;
      for (const order of queue) {
        if (order.targetId === userId) return true;
      }
      return false;
    },

    reset(): void {
      queue.length = 0;
      deferredKo.clear();
      lastImpactAt.clear();
      hitCount = 0;
      host.dataset.hits = '0';
      delete host.dataset.hitSeq;
    },
  };
}
