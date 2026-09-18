import { combatFxFor } from '../assets';
import type { Fighter } from '../fighter/fighter';
import type { FxLayer } from '../effects/layer';
import type { Seating } from './seating';
import type { StageAssets } from './assets';
import type { CombatEvent, Element } from '../../../shared/protocol';
import { COMBAT_EVENT_RING_SIZE } from '../../../shared/protocol';

/** Hold a whole server event ring so a simultaneous volley never partly overflows. */
const QUEUE_LIMIT = COMBAT_EVENT_RING_SIZE;
/** Pacing between two batch launches, so separate casts still read as a volley. */
const SPAWN_GAP_MS = 110;
/** A hit this soon after the last one on the same target is a repeat and lands softer. */
const REPEAT_WINDOW_MS = 150;
/** How long a fighter may stay standing on a killing hit that is still in flight. */
const DEFERRED_KO_MS = 1500;
/**
 * Damage floats share the target's upper-body lane instead of hovering above
 * the head: the headroom belongs to the reserved DOM label band. Both bounds
 * are relative to `seating.topBand`, so the whole trajectory provably stays
 * inside the canvas on every seat and canvas size. The travel margin covers
 * the worst-case label half-height — 45px font at strength 1.35, scaled to
 * 1.15, plus its 5px stroke ≈ 28px above the centre — so even a fading
 * max-strength number never pokes into the band.
 */
const FLOAT_SPAWN_CLEARANCE = 56;
/** Hard ceiling for the drifting float's centre: band edge plus the label margin. */
const FLOAT_TRAVEL_CLEARANCE = 30;

/** One hit to land on a target, exactly as the room's CombatEvent described it. */
export type AttackOrder = {
  seq: number;
  attackerId: string;
  targetId: string;
  element: Element;
  damage: number;
  eliminated: boolean;
  spellIndex: number;
};

/** An `AttackOrder` stamped with its settlement batch; orders sharing `at` launch together. */
export interface AttackOrderWithBatch extends AttackOrder {
  /** Server timestamp of the cast's settlement batch. */
  at: number;
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
  const queue: AttackOrderWithBatch[] = [];
  /** Seats standing on a killing hit that has not landed yet, by slot. */
  const deferredKo = new Map<number, number>();
  const stance = { x: 0, y: 0 };
  const target = { x: 0, y: 0 };
  let spawnClock = 0;
  /** Last impact time per target slot, so a rapid follow-up on one victim lands softer. */
  const lastImpactAt = new Map<number, number>();
  let hitCount = 0;

  const applyImpact = (order: AttackOrder, instant: boolean, clock: number): void => {
    const targetSlot = slotOf(order.targetId);
    const attackerSlot = slotOf(order.attackerId);
    if (targetSlot === undefined) return;

    const seat = seating.geometry[targetSlot];
    const fighter = fighters[targetSlot];
    const base = Math.min(1, Math.max(0.35, order.damage / 64));
    // Softening is per target: the simultaneous blows of one group attack land
    // on different fighters in the same frame and keep their full weight, while
    // a genuine follow-up on the same victim inside the window lands lighter.
    const repeated = clock - (lastImpactAt.get(targetSlot) ?? -1000) < REPEAT_WINDOW_MS;
    lastImpactAt.set(targetSlot, clock);
    const strength = repeated ? base * 0.7 : base;

    // The shove goes away from the attacker, so a hit reads as directed.
    const attackerSeat = attackerSlot !== undefined ? seating.geometry[attackerSlot] : undefined;
    fighter.hit(strength, attackerSeat && attackerSeat.x > seat.x ? -1 : 1);
    // The collapse, shockwave and shake fire exactly once per target: a second
    // killing event for an already-down fighter — the snapshot settled the KO
    // first, or two batch entries name the same victim — must never replay it.
    const koLands = order.eliminated && !fighter.isDown;
    if (koLands) fighter.commitElimination(reduced() || instant);
    if (attackerSlot !== undefined) fighters[attackerSlot].flourish();

    seating.chest(targetSlot, target);
    const art = assets.request(combatFxFor(order.element, order.spellIndex));
    // The number floats out of the target's upper body — sharing the chest
    // lane, never parked high above the head where it would climb into the
    // reserved label band — and its whole ascent is clamped at the band edge.
    const floatCeil = seating.topBand + FLOAT_TRAVEL_CLEARANCE;
    const floatY = Math.max(
      seating.topBand + FLOAT_SPAWN_CLEARANCE,
      seat.feetY - seat.height * 0.74,
    );
    // Impact art is normalised to a fraction of the fighter's height, so a 256px
    // or a 1024px texture lands at the same on-screen size.
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
      // One authoritative settlement batch launches in the same frame: a single
      // cast reads as one volley splitting across every opponent at once, not a
      // serial march of individual hits. The next batch waits out the full gap.
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
