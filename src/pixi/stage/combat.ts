import { combatFxFor } from '../assets';
import type { Fighter } from '../fighter/fighter';
import type { FxLayer } from '../effects/layer';
import type { Seating } from './seating';
import type { StageAssets } from './assets';
import type { CombatEvent, Element } from '../../../shared/protocol';

/** Attacks in flight at once; a full queue applies its overflow on the spot. */
const QUEUE_LIMIT = 6;
/** Pacing between two launches, so a burst reads as a volley. */
const SPAWN_GAP_MS = 110;
/** A hit this soon after the last one is a repeat and lands softer. */
const REPEAT_WINDOW_MS = 150;
/** How long a fighter may stay standing on a killing hit that is still in flight. */
const DEFERRED_KO_MS = 1500;

export interface AttackOrder {
  seq: number;
  attackerId: string;
  targetId: string;
  element: Element;
  damage: number;
  eliminated: boolean;
  spellIndex: number;
}

/** The match-level beats a resolved hit needs. */
export interface CombatBeats {
  /** Reduced motion: the hit landed where it landed, settle that frame. */
  settle(): void;
  /** A kill is worth a screen-shake impulse. */
  shake(amount: number): void;
}

export interface Combat {
  /** Queues one combat event; reduced motion resolves it in place. */
  enqueue(event: CombatEvent, clock: number): void;
  /** Launches queued orders at a fixed pace; once per frame. */
  spawn(deltaMS: number, clock: number): void;
  /** Applies every queued order at once, with no flight (a mode change). */
  flush(clock: number): void;
  /** A bolt reached its target. */
  resolve(order: AttackOrder, clock: number): void;
  /** Records whether a seat is standing on a deferred elimination. */
  defer(slot: number, pending: boolean, clock: number): void;
  /** Commits deferred eliminations whose grace period has run out. */
  sweep(clock: number): void;
  /** True while an attack on this user is flying or queued. */
  incoming(userId: string): boolean;
  reset(): void;
}

/** Everything attack sequencing reads and writes. */
export interface CombatWiring {
  host: HTMLElement;
  fighters: readonly Fighter[];
  /** Seat per user id, as the current snapshot seated them. */
  slotOf: (userId: string) => number | undefined;
  seating: Seating;
  fx: FxLayer;
  assets: StageAssets;
  beats: CombatBeats;
  /** Reduced motion skips projectile flight entirely. */
  reduced: () => boolean;
}

export function createCombat(wiring: CombatWiring): Combat {
  const { host, fighters, slotOf, seating, fx, assets, beats, reduced } = wiring;
  const queue: AttackOrder[] = [];
  /** Seats standing on a killing hit that has not landed yet, by slot. */
  const deferredKo = new Map<number, number>();
  const stance = { x: 0, y: 0 };
  const target = { x: 0, y: 0 };
  let spawnClock = 0;
  let lastImpactAt = -1000;
  let hitCount = 0;

  const applyImpact = (order: AttackOrder, instant: boolean, clock: number): void => {
    const targetSlot = slotOf(order.targetId);
    const attackerSlot = slotOf(order.attackerId);
    if (targetSlot === undefined) return;

    const seat = seating.geometry[targetSlot];
    const fighter = fighters[targetSlot];
    const base = Math.min(1, Math.max(0.35, order.damage / 64));
    const repeated = clock - lastImpactAt < REPEAT_WINDOW_MS;
    lastImpactAt = clock;
    const strength = repeated ? base * 0.7 : base;

    // The shove goes away from the attacker, so a hit reads as directed.
    const attackerSeat = attackerSlot !== undefined ? seating.geometry[attackerSlot] : undefined;
    fighter.hit(strength, attackerSeat && attackerSeat.x > seat.x ? -1 : 1);
    if (order.eliminated) fighter.commitElimination(reduced() || instant);
    if (attackerSlot !== undefined) fighters[attackerSlot].flourish();

    seating.chest(targetSlot, target);
    const art = assets.request(combatFxFor(order.element, order.spellIndex));
    // The number floats above the target's head; the impact stays on the body.
    const floatY = seat.feetY - seat.height * 1.02;
    // Impact art is normalised to a fraction of the fighter's height, so a 256px
    // or a 1024px texture lands at the same on-screen size.
    const artBaseScale = art ? (seat.height * 0.4) / Math.max(1, art.width) : 1;
    fx.impact(
      target.x,
      target.y,
      floatY,
      order.element,
      order.eliminated ? 1.35 : strength,
      order.damage,
      art,
      artBaseScale,
    );
    if (order.eliminated) {
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
      // Reduced motion: no projectile flight, the hit lands where it lands.
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
      const order: AttackOrder = {
        seq: event.seq,
        attackerId: event.attackerId,
        targetId: event.targetId,
        element: event.element,
        damage: event.damage,
        eliminated: event.eliminated,
        spellIndex: event.spellIndex,
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
      while (queue.length > 0 && spawnClock <= 0) {
        const order = queue.shift();
        if (!order) break;
        launch(order, clock);
        spawnClock = SPAWN_GAP_MS;
      }
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
      hitCount = 0;
      host.dataset.hits = '0';
      delete host.dataset.hitSeq;
    },
  };
}
