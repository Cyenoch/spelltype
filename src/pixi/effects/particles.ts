import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';
import type { SparkPool } from '../particles';
import { IMPACT_STYLES, type BoltStyle, type ImpactStyle } from './styles';

/**
 * One deterministic jitter stream, shared by every effect that randomises a path
 * or a burst: the same match always draws the same shapes.
 */
export function createJitter(seed = 7): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state;
  };
}

/** The trail a flying bolt sheds behind itself. */
export function emitBoltTrail(
  pool: SparkPool,
  style: BoltStyle,
  x: number,
  y: number,
  aheadX: number,
  aheadY: number,
  progress: number,
): void {
  const spread = 6;
  for (let index = 0; index < style.trailCount; index += 1) {
    const angle = (index / style.trailCount) * Math.PI * 2 + progress * 9;
    pool.spawn(
      x + Math.cos(angle) * spread,
      y + Math.sin(angle) * spread,
      -Math.cos(angle) * style.trailSpeed - (aheadX - x) * 0.02,
      -Math.sin(angle) * style.trailSpeed - (aheadY - y) * 0.02,
      style.trailLife,
      style.trailSize,
      style.trailSize * 0.2,
      style.trailTint,
      0.8,
      0.003,
      style.trailGravity,
      style.trailDrag,
    );
  }
}

/**
 * Radial shard burst of one element impact. `strength` sets the count and
 * `strengthScale` the sizes, exactly as the impact's flash and extras use them.
 */
export function emitImpactShards(
  pool: SparkPool,
  style: ImpactStyle,
  x: number,
  y: number,
  element: Element,
  strength: number,
  strengthScale: number,
  seed: () => number,
): void {
  const color = ELEMENT_COLORS[element];
  const core = ELEMENT_CORE[element];
  const count = Math.round(style.shardCount * (0.7 + strength * 0.6));
  for (let index = 0; index < count; index += 1) {
    const angle = (Math.PI * 2 * index) / count + seed() * 0.00002;
    const speed = style.shardSpeed * (0.55 + ((index * 37) % 10) / 12);
    pool.spawn(
      x,
      y,
      Math.cos(angle) * speed,
      Math.sin(angle) * speed + style.shardGravity * 40,
      style.shardLife * (0.7 + ((index * 13) % 10) / 20),
      style.shardSize * strengthScale,
      style.shardSize * strengthScale * 0.25,
      index % 3 === 0 ? core : color,
      0.95,
      (index % 2 === 0 ? 1 : -1) * 0.004,
      style.shardGravity,
      style.shardDrag,
    );
  }
}

/** The eliminated fighter's collapse: a ring of sparks thrown up and outwards. */
export function emitEliminationBurst(
  pool: SparkPool,
  x: number,
  y: number,
  element: Element,
): void {
  const color = ELEMENT_COLORS[element];
  const core = ELEMENT_CORE[element];
  for (let index = 0; index < 34; index += 1) {
    const angle = (Math.PI * 2 * index) / 34;
    pool.spawn(
      x,
      y,
      Math.cos(angle) * 0.11,
      Math.sin(angle) * 0.11 - 0.2,
      900 + (index % 5) * 60,
      1,
      0.2,
      index % 2 === 0 ? core : color,
      0.9,
      0.003,
      0.00002,
      0.0016,
    );
  }
}

/** Ring of golden embers rising off the rank-1 winner's victory seal. */
export function emitVictoryEmbers(pool: SparkPool, x: number, groundY: number): void {
  for (let index = 0; index < 26; index += 1) {
    const angle = (Math.PI * 2 * index) / 26;
    pool.spawn(
      x + Math.cos(angle) * 34,
      groundY,
      Math.cos(angle) * 0.014,
      -0.09 - (index % 5) * 0.016,
      1800,
      0.9,
      0.12,
      0xffd79a,
      0.9,
      0.003,
      -0.00001,
      0.0006,
    );
  }
}

/**
 * The same confirmed keystroke, seen from the other end: motes fall from the
 * top edge of the arena, under the readout strip the DOM owns, into the
 * caster. Nothing is drawn over the text itself, so the font stays legible.
 */
export function emitTextMotes(
  pool: SparkPool,
  x: number,
  element: Element,
  count: number,
  seed: () => number,
): void {
  const color = ELEMENT_COLORS[element];
  const core = ELEMENT_CORE[element];
  for (let index = 0; index < count; index += 1) {
    const spread = (index - (count - 1) / 2) * 17;
    pool.spawn(
      x + spread + (seed() % 9) - 4,
      8,
      spread * 0.0004,
      0.05 + (index % 3) * 0.02,
      900 + (index % 4) * 120,
      0.55,
      0.12,
      index % 2 === 0 ? core : color,
      0.9,
      0.004,
      0.00005,
      0.0006,
    );
  }
}

/** Confirmed-keystroke feedback: a small element spark at the caster. */
export function emitTypingSpark(
  pool: SparkPool,
  x: number,
  y: number,
  element: Element,
  amount: number,
): void {
  const color = ELEMENT_COLORS[element];
  const core = ELEMENT_CORE[element];
  const style = IMPACT_STYLES[element];
  for (let index = 0; index < amount; index += 1) {
    const angle = -Math.PI / 2 + (index - (amount - 1) / 2) * 0.5;
    const speed = 0.05 + index * 0.008;
    pool.spawn(
      x,
      y,
      Math.cos(angle) * speed,
      Math.sin(angle) * speed,
      420 + index * 30,
      0.55,
      0.1,
      index % 2 === 0 ? core : color,
      0.85,
      0.004,
      style.shardGravity * 0.5,
      0.002,
    );
  }
}
