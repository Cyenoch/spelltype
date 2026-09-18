import type { Element } from '../../../shared/protocol';

export interface BoltStyle {
  /** Flight time in ms. */
  travel: number;
  /** Perpendicular bow, px at mid-flight. */
  hop: number;
  /** Downward acceleration applied after the arc. */
  drop: number;
  path: 'straight' | 'wave' | 'arc' | 'zigzag';
  spin: number;
  coreScale: number;
  glowScale: number;
  /** ms between trail emissions. */
  trailEvery: number;
  trailCount: number;
  trailLife: number;
  trailSize: number;
  trailSpeed: number;
  trailGravity: number;
  trailDrag: number;
  trailTint: number;
}

export const BOLT_STYLES: Record<Element, BoltStyle> = {
  arcane: {
    travel: 460,
    hop: 26,
    drop: 0,
    path: 'wave',
    spin: 0.006,
    coreScale: 1,
    glowScale: 2.6,
    trailEvery: 34,
    trailCount: 2,
    trailLife: 520,
    trailSize: 0.5,
    trailSpeed: 0.01,
    trailGravity: -0.00002,
    trailDrag: 0.002,
    trailTint: 0xb7a8ff,
  },
  fire: {
    travel: 420,
    hop: 70,
    drop: 190,
    path: 'arc',
    spin: -0.004,
    coreScale: 1.05,
    glowScale: 3,
    trailEvery: 22,
    trailCount: 3,
    trailLife: 640,
    trailSize: 0.55,
    trailSpeed: 0.014,
    trailGravity: -0.00022,
    trailDrag: 0.0012,
    trailTint: 0xffb066,
  },
  ice: {
    travel: 330,
    hop: 0,
    drop: 0,
    path: 'straight',
    spin: 0.012,
    coreScale: 0.95,
    glowScale: 2.2,
    trailEvery: 26,
    trailCount: 2,
    trailLife: 420,
    trailSize: 0.48,
    trailSpeed: 0.02,
    trailGravity: 0.00012,
    trailDrag: 0.006,
    trailTint: 0xc7efff,
  },
  storm: {
    travel: 280,
    hop: 0,
    drop: 0,
    path: 'zigzag',
    spin: 0,
    coreScale: 1.15,
    glowScale: 3.2,
    trailEvery: 16,
    trailCount: 3,
    trailLife: 340,
    trailSize: 0.42,
    trailSpeed: 0.024,
    trailGravity: 0,
    trailDrag: 0.006,
    trailTint: 0xf2ffa8,
  },
};

export interface ImpactStyle {
  ringScale: number;
  ringTint: number;
  flashAlpha: number;
  flashScale: number;
  /** Extras: [angle°, distance px, spin rad/ms, scale, gravity px/ms², delay ms] */
  extras: readonly (readonly [number, number, number, number, number, number])[];
  shardCount: number;
  shardSpeed: number;
  shardLife: number;
  shardGravity: number;
  shardDrag: number;
  shardSize: number;
  extraTexture: 'shard' | 'rune' | 'spike';
}

export const IMPACT_STYLES: Record<Element, ImpactStyle> = {
  arcane: {
    ringScale: 3.4,
    ringTint: 0xc9bcff,
    flashAlpha: 0.6,
    flashScale: 3.6,
    extras: [
      [0, 10, 0.004, 1.5, 0, 0],
      [140, 22, -0.006, 1.1, 0, 60],
      [250, 16, 0.008, 0.9, 0, 120],
    ],
    extraTexture: 'rune',
    shardCount: 12,
    shardSpeed: 0.13,
    shardLife: 760,
    shardGravity: 0.00004,
    shardDrag: 0.0025,
    shardSize: 0.9,
  },
  fire: {
    ringScale: 3,
    ringTint: 0xffb173,
    flashAlpha: 0.66,
    flashScale: 4,
    extras: [
      [0, 14, 0.002, 1.8, -0.00012, 0],
      [180, 20, -0.003, 1.3, -0.00016, 70],
      [90, 26, 0.004, 1, -0.0001, 140],
    ],
    extraTexture: 'shard',
    shardCount: 18,
    shardSpeed: 0.19,
    shardLife: 820,
    shardGravity: -0.00016,
    shardDrag: 0.0018,
    shardSize: 1.25,
  },
  ice: {
    ringScale: 3.8,
    ringTint: 0xbfecff,
    flashAlpha: 0.58,
    flashScale: 3.2,
    extras: [
      [180, 18, 0, 1.5, 0, 0],
      [0, 24, 0, 1.3, 0, 90],
      [270, 10, 0, 1.15, 0, 170],
    ],
    extraTexture: 'spike',
    shardCount: 16,
    shardSpeed: 0.18,
    shardLife: 700,
    shardGravity: 0.0002,
    shardDrag: 0.0035,
    shardSize: 0.95,
  },
  storm: {
    ringScale: 4.2,
    ringTint: 0xf4ffb0,
    flashAlpha: 0.62,
    flashScale: 3.4,
    extras: [
      [-40, 16, 0.02, 1.4, 0, 0],
      [30, 22, -0.018, 1.2, 0, 40],
      [110, 13, 0.024, 1, 0, 80],
    ],
    extraTexture: 'shard',
    shardCount: 22,
    shardSpeed: 0.24,
    shardLife: 460,
    shardGravity: 0.00006,
    shardDrag: 0.007,
    shardSize: 0.8,
  },
};

export const BOLT_SLOTS = 8;
export const IMPACT_SLOTS = 10;
export const WAVE_SLOTS = 6;
export const FLOAT_SLOTS = 6;
export const EXTRAS_PER_IMPACT = 3;
