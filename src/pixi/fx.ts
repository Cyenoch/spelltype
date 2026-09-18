import { Container, Graphics, Sprite, Text, type Application, type Texture } from 'pixi.js';
import { ELEMENT_ORDER } from '../assets';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../elements';
import type { Element } from '../../shared/protocol';
import type { SparkPool } from './particles';

/**
 * Element-effect shapes are drawn once into textures at startup and then only
 * positioned, scaled and tinted per frame. That keeps the whole effect layer to
 * sprite batches (no per-frame vector rebuild, no filters) and keeps the vertex
 * work tiny on high-DPI screens.
 */
export interface FxTextures {
  /** Soft radial blob: auras, muzzle glow, impact flash, light columns. */
  glow: Texture;
  /** Thin annulus: shockwaves and impact rings. */
  ring: Texture;
  bolt: Record<Element, Texture>;
  shard: Record<Element, Texture>;
  rune: Record<Element, Texture>;
  /** Narrow crystal pillar, tinted at use. */
  spike: Texture;
}

type Point = { x: number; y: number };

const SHAPE_RESOLUTION = 2;

function drawGlow(g: Graphics): void {
  const steps = 12;
  for (let step = 0; step < steps; step += 1) {
    const radius = 34 * (1 - step / (steps + 1));
    g.circle(0, 0, radius).fill({ color: 0xffffff, alpha: 0.055 });
  }
}

function drawRing(g: Graphics): void {
  g.circle(0, 0, 30).stroke({ width: 4, color: 0xffffff, alpha: 0.95 });
  g.circle(0, 0, 23).stroke({ width: 1.5, color: 0xffffff, alpha: 0.45 });
}

function drawBolt(g: Graphics, element: Element, color: number, core: number): void {
  switch (element) {
    case 'arcane':
      g.poly([18, 0, 0, 9, -18, 0, 0, -9]).fill({ color });
      g.poly([10, 0, 0, 5, -10, 0, 0, -5]).fill({ color: core });
      g.circle(-22, 5, 2).fill({ color: core, alpha: 0.8 });
      g.circle(-27, -4, 1.6).fill({ color: core, alpha: 0.6 });
      break;
    case 'fire':
      g.poly([16, 0, 2, -9, -30, -5, -16, 0, -30, 5, 2, 9]).fill({ color });
      g.ellipse(3, 0, 8, 6.5).fill({ color: core });
      break;
    case 'ice':
      g.poly([19, 0, 6, -6.5, -13, -5, -19, 0, -13, 5, 6, 6.5]).fill({ color });
      g.poly([11, 0, 2, -3.2, -7, -2.6, -11, 0, -7, 2.6, 2, 3.2]).fill({ color: core });
      break;
    case 'storm':
      g.moveTo(-22, 0)
        .lineTo(-9, -7)
        .lineTo(0, 5)
        .lineTo(9, -5)
        .lineTo(22, 0)
        .stroke({ width: 7, color, alpha: 0.5, cap: 'round', join: 'round' });
      g.moveTo(-22, 0)
        .lineTo(-9, -7)
        .lineTo(0, 5)
        .lineTo(9, -5)
        .lineTo(22, 0)
        .stroke({ width: 3, color: core, cap: 'round', join: 'round' });
      break;
  }
}

/**
 * Draws one element's spark shape in plain white, so every user of it decides the
 * colour by tinting: the same shape serves the arena's particle pools and the
 * text overlay's sparks.
 */
export function drawElementShard(g: Graphics, element: Element): void {
  switch (element) {
    case 'arcane':
      g.poly([0, -8, 2.6, -2.6, 8, 0, 2.6, 2.6, 0, 8, -2.6, 2.6, -8, 0, -2.6, -2.6]).fill({
        color: 0xffffff,
      });
      break;
    case 'fire':
      g.poly([6, 0, 0, -5, -9, -2, -4, 0, -9, 2, 0, 5]).fill({ color: 0xffffff, alpha: 0.9 });
      g.circle(2, 0, 3).fill({ color: 0xffffff });
      break;
    case 'ice':
      g.poly([7, 0, 3.5, -5, -3.5, -5, -7, 0, -3.5, 5, 3.5, 5]).fill({ color: 0xffffff });
      break;
    case 'storm':
      g.poly([0, -7, 6, 5, 0, 2.5, -6, 5]).fill({ color: 0xffffff });
      break;
  }
}

function drawRune(g: Graphics, sides: number): void {
  // Drawn in plain white so the user's tint fully decides the colour: the same
  // shape serves element impacts and the golden victory seal.
  g.circle(0, 0, 27).stroke({ width: 2, color: 0xffffff, alpha: 0.95 });
  const points: number[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = (Math.PI * 2 * index) / sides - Math.PI / 2;
    points.push(Math.cos(angle) * 21, Math.sin(angle) * 21);
  }
  g.poly(points).stroke({ width: 1.5, color: 0xffffff, alpha: 0.8 });
  for (let index = 0; index < 6; index += 1) {
    const angle = (Math.PI * 2 * index) / 6;
    g.moveTo(Math.cos(angle) * 28, Math.sin(angle) * 28)
      .lineTo(Math.cos(angle) * 35, Math.sin(angle) * 35)
      .stroke({ width: 2, color: 0xffffff, alpha: 0.7 });
  }
}

function drawSpike(g: Graphics): void {
  g.poly([-7, 4, -2, -30, 1.5, -46, 5, -28, 7, 4]).fill({ color: 0xffffff });
}

/** Builds every element shape once. Returns plain `Texture`s owned by the caller. */
export function createFxTextures(app: Application): FxTextures {
  const generate = (build: (g: Graphics) => void): Texture => {
    const graphics = new Graphics();
    build(graphics);
    // Anchors are set on each sprite, so the generated frame stays the raw shape bounds.
    const texture = app.renderer.generateTexture({
      target: graphics,
      resolution: SHAPE_RESOLUTION,
      antialias: true,
    });
    graphics.destroy();
    return texture;
  };

  const bolt = {} as Record<Element, Texture>;
  const shard = {} as Record<Element, Texture>;
  const rune = {} as Record<Element, Texture>;
  const runeSides: Record<Element, number> = { arcane: 3, fire: 4, ice: 6, storm: 5 };
  for (const element of ELEMENT_ORDER) {
    const color = ELEMENT_COLORS[element];
    const core = ELEMENT_CORE[element];
    bolt[element] = generate((g) => drawBolt(g, element, color, core));
    shard[element] = generate((g) => drawElementShard(g, element));
    rune[element] = generate((g) => drawRune(g, runeSides[element]));
  }

  return {
    glow: generate(drawGlow),
    ring: generate(drawRing),
    spike: generate(drawSpike),
    bolt,
    shard,
    rune,
  };
}

/** Releases the generated shapes; the stage calls this exactly once on destroy. */
export function destroyFxTextures(textures: FxTextures): void {
  const destroyOne = (texture: Texture): void => {
    if (!texture.destroyed) texture.destroy(true);
  };
  destroyOne(textures.glow);
  destroyOne(textures.ring);
  destroyOne(textures.spike);
  for (const element of ELEMENT_ORDER) {
    destroyOne(textures.bolt[element]);
    destroyOne(textures.shard[element]);
    destroyOne(textures.rune[element]);
  }
}

interface BoltStyle {
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

const BOLT_STYLES: Record<Element, BoltStyle> = {
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

interface ImpactStyle {
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

const IMPACT_STYLES: Record<Element, ImpactStyle> = {
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

const BOLT_SLOTS = 8;
const IMPACT_SLOTS = 10;
const WAVE_SLOTS = 6;
const FLOAT_SLOTS = 6;
const EXTRAS_PER_IMPACT = 3;

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

interface ExtraSlot {
  sprite: Sprite;
  angle: number;
  distance: number;
  spin: number;
  scale: number;
  gravity: number;
  delay: number;
}

interface ImpactSlot {
  view: Container;
  ring: Sprite;
  /** Generated impact artwork from the asset registry, when one is available. */
  art: Sprite;
  flash: Sprite;
  extras: ExtraSlot[];
  active: boolean;
  /** `true` for a slow, tall light column (victory) instead of a burst. */
  hold: boolean;
  element: Element;
  strength: number;
  elapsed: number;
  duration: number;
  ringAspect: number;
  flashAspect: number;
  baseScale: number;
  /** Radians per millisecond the ring turns while it holds. */
  spin: number;
  /** Sprite scale for the impact artwork at its resting size. */
  artBaseScale: number;
}

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

function createImpactSlot(textures: FxTextures): ImpactSlot {
  const view = new Container();
  const ring = new Sprite(textures.ring);
  ring.anchor.set(0.5);
  ring.blendMode = 'add';
  const flash = new Sprite(textures.glow);
  flash.anchor.set(0.5);
  flash.blendMode = 'add';
  const art = new Sprite(textures.glow);
  art.anchor.set(0.5);
  art.blendMode = 'add';
  art.visible = false;
  view.addChild(ring, art, flash);
  const extras: ExtraSlot[] = [];
  for (let index = 0; index < EXTRAS_PER_IMPACT; index += 1) {
    const sprite = new Sprite(textures.shard.arcane);
    sprite.anchor.set(0.5);
    sprite.blendMode = 'add';
    sprite.visible = false;
    view.addChild(sprite);
    extras.push({ sprite, angle: 0, distance: 0, spin: 0, scale: 1, gravity: 0, delay: 0 });
  }
  view.visible = false;
  return {
    view,
    ring,
    art,
    flash,
    extras,
    active: false,
    hold: false,
    element: 'arcane',
    strength: 1,
    elapsed: 0,
    duration: 1,
    ringAspect: 1,
    flashAspect: 1,
    baseScale: 1,
    spin: 0,
    artBaseScale: 1,
  };
}

/**
 * Bolts, impacts, shockwaves, typing sparks and damage floats.
 *
 * Every visual lives in a preallocated slot, so a match with hundreds of hits
 * never allocates during play and the layer can never grow past its bound. The
 * layer is pure presentation: it never decides damage, only shows what the
 * authoritative `CombatEvent` already said.
 */
export class FxLayer {
  readonly ground = new Container();
  readonly air = new Container();

  /** Set once by the stage; fired when a bolt reaches its target. */
  onLanded: ((bolt: BoltLanded) => void) | null = null;

  private readonly textures: FxTextures;
  private readonly pools: Record<Element, SparkPool>;
  /** Caps impact brightness further when the page asked for gentler motion. */
  private safeFlash: boolean;
  private readonly bolts: BoltSlot[] = [];
  private readonly impacts: ImpactSlot[] = [];
  private readonly waves: WaveSlot[] = [];
  private readonly floats: FloatSlot[] = [];
  private readonly point: Point = { x: 0, y: 0 };
  private readonly lookahead: Point = { x: 0, y: 0 };
  private jitterSeed = 7;

  constructor(textures: FxTextures, pools: Record<Element, SparkPool>, safeFlash: boolean) {
    this.textures = textures;
    this.pools = pools;
    this.safeFlash = safeFlash;

    for (let index = 0; index < BOLT_SLOTS; index += 1) {
      const slot = createBoltSlot(textures);
      this.bolts.push(slot);
      this.air.addChild(slot.view);
    }
    for (let index = 0; index < IMPACT_SLOTS; index += 1) {
      const slot = createImpactSlot(textures);
      this.impacts.push(slot);
      this.air.addChild(slot.view);
    }
    // The element pools live above the fighters with the rest of the air layer,
    // and their containers are added here so a spawn is actually on screen.
    for (const element of ELEMENT_ORDER) this.air.addChild(pools[element].view);
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
      this.air.addChild(view);
      this.floats.push({ view, label, active: false, elapsed: 0, duration: 1, drift: 0 });
    }
    for (let index = 0; index < WAVE_SLOTS; index += 1) {
      const sprite = new Sprite(textures.ring);
      sprite.anchor.set(0.5);
      sprite.blendMode = 'add';
      sprite.visible = false;
      this.ground.addChild(sprite);
      this.waves.push({ sprite, active: false, elapsed: 0, duration: 1, strength: 1 });
    }
  }

  /** Starts a projectile flight. Purely visual; the DOM/rules are unaffected. */
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
    const slot = this.takeBolt();
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
      const seed = this.nextSeed();
      const jitter = 30 + (seed % 24);
      const sign = seed % 2 === 0 ? 1 : -1;
      slot.nodes[2] = fromX + dx * 0.36 - dy * 0.0008 * jitter * sign;
      slot.nodes[3] = fromY + dy * 0.36 + dx * 0.0008 * jitter * sign;
      slot.nodes[4] = fromX + dx * 0.68 + dy * 0.0008 * jitter;
      slot.nodes[5] = fromY + dy * 0.68 - dx * 0.0008 * jitter;
    }

    slot.view.visible = true;
    slot.view.alpha = 1;
    // Bolt children are positioned in absolute arena coordinates by `pathAt`,
    // so the container itself must not also carry the launch offset.
    slot.view.position.set(0, 0);
  }

  /** Cheap deterministic jitter source so two bolts never take the same path. */
  private nextSeed(): number {
    this.jitterSeed = (this.jitterSeed * 1103515245 + 12345) % 2147483648;
    return this.jitterSeed;
  }

  /**
   * One hit's visible aftermath: shockwave on the ground, element ring, flash,
   * element shapes, shards and a floating damage number.
   */
  impact(
    x: number,
    y: number,
    floatY: number,
    element: Element,
    strength: number,
    damage: number,
    artTexture: Texture | null,
    /** Sprite scale that makes the art the size the stage wants, at rest. */
    artBaseScale: number,
  ): void {
    const style = IMPACT_STYLES[element];
    const color = ELEMENT_COLORS[element];
    const core = ELEMENT_CORE[element];
    const strengthScale = 0.75 + Math.min(1, Math.max(0, strength)) * 0.45;

    const slot = this.takeImpact();
    slot.active = true;
    slot.hold = false;
    slot.spin = 0;
    slot.ringAspect = 1;
    slot.flashAspect = 1;
    slot.element = element;
    slot.strength = strength;
    slot.elapsed = 0;
    slot.duration = 620;
    slot.view.visible = true;
    slot.view.position.set(x, y);
    slot.ring.texture = this.textures.ring;
    slot.ring.blendMode = 'add';
    slot.ring.tint = style.ringTint;
    slot.ring.scale.set(0.6);
    slot.ring.alpha = 1;
    slot.flash.tint = element === 'fire' ? core : color;
    slot.flash.scale.set(style.flashScale * strengthScale * 0.5);
    slot.flash.alpha = 0;

    if (artTexture) {
      slot.art.texture = artTexture;
      slot.art.tint = 0xffffff;
      slot.art.visible = true;
      slot.art.alpha = 0.95;
      slot.art.rotation = 0;
      slot.artBaseScale = artBaseScale;
      slot.art.scale.set(artBaseScale * 0.55 * strengthScale);
    } else {
      slot.art.visible = false;
    }

    const extras = style.extras;
    for (let index = 0; index < EXTRAS_PER_IMPACT; index += 1) {
      const extra = slot.extras[index];
      const spec = extras[index];
      extra.sprite.texture =
        style.extraTexture === 'spike'
          ? this.textures.spike
          : this.textures[style.extraTexture][element];
      extra.sprite.tint = index % 2 === 0 ? core : color;
      extra.angle = (spec[0] * Math.PI) / 180;
      extra.distance = spec[1] * strengthScale;
      extra.spin = spec[2];
      extra.scale = spec[3] * strengthScale;
      extra.gravity = spec[4];
      extra.delay = spec[5];
      extra.sprite.visible = true;
      extra.sprite.alpha = 1;
      extra.sprite.scale.set(extra.scale);
      extra.sprite.position.set(0, 0);
      extra.sprite.rotation = 0;
    }

    const pool = this.pools[element];
    const count = Math.round(style.shardCount * (0.7 + strength * 0.6));
    for (let index = 0; index < count; index += 1) {
      const angle = (Math.PI * 2 * index) / count + this.nextSeed() * 0.00002;
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

    this.groundWave(x, y + 4, color, strength);
    this.floatDamage(x, floatY, element, damage, strength);
  }

  /** Expanding ground ring, used by hits and eliminations. */
  groundWave(x: number, y: number, tint: number, strength: number): void {
    const slot = this.wave();
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

  /** The eliminated fighter's collapse: big ring, upward column of sparks, shards. */
  elimination(x: number, y: number, element: Element): void {
    const color = ELEMENT_COLORS[element];
    const core = ELEMENT_CORE[element];
    const pool = this.pools[element];

    this.groundWave(x, y, color, 1.6);
    const slot = this.takeImpact();
    slot.active = true;
    slot.hold = false;
    slot.spin = 0;
    slot.ringAspect = 1;
    slot.flashAspect = 1;
    slot.element = element;
    slot.strength = 1.4;
    slot.elapsed = 0;
    slot.duration = 900;
    slot.view.visible = true;
    slot.view.position.set(x, y);
    slot.ring.texture = this.textures.ring;
    slot.ring.blendMode = 'add';
    slot.ring.tint = core;
    slot.ring.scale.set(0.8);
    slot.ring.alpha = 0.9;
    slot.flash.tint = color;
    slot.flash.scale.set(5);
    slot.flash.alpha = 0;
    slot.art.visible = false;
    for (const extra of slot.extras) extra.sprite.visible = false;

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

  /**
   * Rank-1 flourish at the end of a match: a golden seal on the floor, a rune
   * crown rising over the winner's head and a ring of embers. Everything is a
   * crisp stroked shape, because soft additive light disappears against the
   * bright arena sky.
   */
  victoryPillar(x: number, crownY: number, groundY: number, tint: number): void {
    const seal = this.takeImpact();
    seal.active = true;
    seal.hold = true;
    seal.spin = 0.0004;
    seal.element = 'arcane';
    seal.strength = 1;
    seal.elapsed = 0;
    seal.duration = 2600;
    seal.ringAspect = 0.26;
    seal.flashAspect = 1;
    seal.baseScale = 3.2;
    seal.view.visible = true;
    seal.view.position.set(x, groundY);
    seal.ring.texture = this.textures.rune.arcane;
    seal.ring.blendMode = 'add';
    seal.ring.tint = tint;
    seal.ring.scale.set(seal.baseScale, seal.baseScale * seal.ringAspect);
    seal.ring.alpha = 0.85;
    seal.flash.tint = 0xffe9b0;
    seal.flash.scale.set(2.4, 2.4);
    seal.flash.alpha = 0;
    seal.art.visible = false;
    for (const extra of seal.extras) extra.sprite.visible = false;

    const crown = this.takeImpact();
    crown.active = true;
    crown.hold = true;
    crown.spin = -0.0012;
    crown.element = 'arcane';
    crown.strength = 1;
    crown.elapsed = 0;
    crown.duration = 2600;
    crown.ringAspect = 1;
    crown.flashAspect = 1;
    crown.baseScale = 1.5;
    crown.view.visible = true;
    crown.view.position.set(x, crownY);
    crown.ring.texture = this.textures.rune.fire;
    crown.ring.blendMode = 'add';
    crown.ring.tint = tint;
    crown.ring.scale.set(crown.baseScale, crown.baseScale);
    crown.ring.alpha = 0.9;
    crown.flash.tint = 0xfff2cf;
    crown.flash.scale.set(1.6, 1.6);
    crown.flash.alpha = 0;
    crown.art.visible = false;
    for (const extra of crown.extras) extra.sprite.visible = false;

    for (let index = 0; index < 26; index += 1) {
      const angle = (Math.PI * 2 * index) / 26;
      this.pools.arcane.spawn(
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
  textMotes(x: number, element: Element, count: number): void {
    const pool = this.pools[element];
    const color = ELEMENT_COLORS[element];
    const core = ELEMENT_CORE[element];
    for (let index = 0; index < count; index += 1) {
      const spread = (index - (count - 1) / 2) * 17;
      pool.spawn(
        x + spread + (this.nextSeed() % 9) - 4,
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
  typingSpark(x: number, y: number, element: Element, amount: number): void {
    const pool = this.pools[element];
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

  /** Advances every live effect. Called once per frame by the stage. */
  update(deltaMS: number): void {
    this.updateBolts(deltaMS);
    this.updateImpacts(deltaMS);
    this.updateWaves(deltaMS);
    this.updateFloats(deltaMS);
    for (const element of ELEMENT_ORDER) this.pools[element].update(deltaMS);
  }

  /** True while a projectile is still flying towards this fighter. */
  incomingFor(targetId: string): boolean {
    for (const slot of this.bolts) {
      if (slot.active && slot.targetId === targetId) return true;
    }
    return false;
  }

  /** True while any projectile is in flight, used by the reduced-motion settle. */
  get airborne(): boolean {
    for (const slot of this.bolts) {
      if (slot.active) return true;
    }
    return false;
  }

  /**
   * Live `prefers-reduced-motion` change: from the next spawn on, impact flashes
   * are capped the same way they are for a match started in reduced motion. The
   * caller clears in-flight transients itself; nothing here mid-flight changes.
   */
  setReducedMotion(reduced: boolean): void {
    this.safeFlash = reduced;
  }

  clear(): void {
    for (const slot of this.bolts) {
      slot.active = false;
      slot.view.visible = false;
    }
    for (const slot of this.impacts) {
      slot.active = false;
      slot.view.visible = false;
    }
    for (const slot of this.waves) {
      slot.active = false;
      slot.sprite.visible = false;
    }
    for (const slot of this.floats) {
      slot.active = false;
      slot.view.visible = false;
    }
  }

  destroy(): void {
    this.onLanded = null;
    this.ground.destroy({ children: true });
    this.air.destroy({ children: true });
  }

  private updateBolts(deltaMS: number): void {
    for (const slot of this.bolts) {
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
        Math.atan2(this.lookahead.y - this.point.y, this.lookahead.x - this.point.x) + slot.spinPhase;
      const fade = 1 - Math.max(0, (progress - 0.86) / 0.14);
      slot.core.alpha = fade;
      slot.glow.alpha = 0.7 * fade;

      slot.trailClock += deltaMS;
      while (slot.trailClock >= style.trailEvery) {
        slot.trailClock -= style.trailEvery;
        const spread = 6;
        for (let index = 0; index < style.trailCount; index += 1) {
          const angle = (index / style.trailCount) * Math.PI * 2 + progress * 9;
          this.pools[slot.element].spawn(
            this.point.x + Math.cos(angle) * spread,
            this.point.y + Math.sin(angle) * spread,
            -Math.cos(angle) * style.trailSpeed - (this.lookahead.x - this.point.x) * 0.02,
            -Math.sin(angle) * style.trailSpeed - (this.lookahead.y - this.point.y) * 0.02,
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
    // Sag peaks mid-flight and vanishes at both ends, so a ballistic bolt still
    // arrives exactly on the target instead of landing below it.
    out.y += style.drop * t * (1 - t) * 4;
  }

  private updateImpacts(deltaMS: number): void {
    for (const slot of this.impacts) {
      if (!slot.active) continue;
      slot.elapsed += deltaMS;
      const progress = Math.min(1, slot.elapsed / slot.duration);
      const style = IMPACT_STYLES[slot.element];
      const eased = 1 - (1 - progress) * (1 - progress);

      if (slot.hold) {
        // A seal turning slowly in place instead of bursting outwards.
        const scale = slot.baseScale * (0.94 + eased * 0.16);
        slot.ring.scale.set(scale, scale * slot.ringAspect);
        slot.ring.rotation += slot.spin * deltaMS;
        slot.ring.alpha = (slot.baseScale > 1.5 ? 0.85 : 0.9) * (1 - progress * 0.85);
        slot.flash.alpha = Math.max(0, 0.24 * (1 - progress));
        const flashScale = (slot.baseScale > 1.5 ? 2.2 : 1.4) + eased * 0.5;
        slot.flash.scale.set(flashScale, flashScale * slot.flashAspect);
        if (progress >= 1) {
          slot.active = false;
          slot.view.visible = false;
        }
        continue;
      }

      const scale = 0.6 + style.ringScale * eased * (0.8 + slot.strength * 0.3);
      slot.ring.scale.set(scale, scale * slot.ringAspect);
      slot.ring.alpha = (1 - progress) * 0.95;

      if (progress < 0.22) {
        const peak = slot.flash.alpha;
        const wanted = (1 - progress / 0.22) * style.flashAlpha * (this.safeFlash ? 0.8 : 1);
        slot.flash.alpha = Math.max(peak, wanted);
      } else {
        slot.flash.alpha = Math.max(0, slot.flash.alpha - deltaMS / 180);
      }
      const flashScale = style.flashScale * (0.5 + eased * 1.1) * (0.8 + slot.strength * 0.3);
      slot.flash.scale.set(flashScale, flashScale * slot.flashAspect);

      if (slot.art.visible) {
        const artProgress = Math.min(1, progress / 0.62);
        const artScale = slot.artBaseScale * (0.55 + artProgress * 1.05) * (0.75 + slot.strength * 0.45);
        slot.art.scale.set(artScale);
        slot.art.rotation += deltaMS * (slot.element === 'arcane' ? 0.0012 : -0.0008);
        slot.art.alpha = (1 - artProgress) * 0.95;
      }

      for (const extra of slot.extras) {
        if (!extra.sprite.visible) continue;
        const local = (slot.elapsed - extra.delay) / Math.max(1, slot.duration - extra.delay);
        if (local <= 0) {
          extra.sprite.alpha = 0;
          continue;
        }
        const clamped = Math.min(1, local);
        const out = 1 - (1 - clamped) * (1 - clamped);
        const distance = extra.distance * out;
        extra.sprite.position.set(
          Math.cos(extra.angle) * distance,
          Math.sin(extra.angle) * distance + extra.gravity * slot.elapsed * slot.elapsed * 0.001,
        );
        extra.sprite.rotation += extra.spin * deltaMS;
        const scale = extra.scale * (0.4 + out * 0.9);
        extra.sprite.scale.set(scale);
        extra.sprite.alpha = (1 - clamped) * 0.9;
      }

      if (progress < 1) continue;
      slot.active = false;
      slot.view.visible = false;
    }
  }

  private updateWaves(deltaMS: number): void {
    for (const slot of this.waves) {
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
  }

  private updateFloats(deltaMS: number): void {
    for (const slot of this.floats) {
      if (!slot.active) continue;
      slot.elapsed += deltaMS;
      const progress = Math.min(1, slot.elapsed / slot.duration);
      const eased = 1 - (1 - progress) * (1 - progress);
      slot.view.y -= deltaMS * slot.drift;
      slot.view.alpha = progress < 0.7 ? 1 : 1 - (progress - 0.7) / 0.3;
      slot.view.scale.set(0.7 + eased * 0.45);
      if (progress < 1) continue;
      slot.active = false;
      slot.view.visible = false;
    }
  }

  private floatDamage(x: number, y: number, element: Element, damage: number, strength: number): void {
    // The float pool rotates: with every slot busy the oldest number is replaced
    // rather than a seventh one being created. Plain loops, not `.find` — this
    // runs per hit and a closure per call is an allocation.
    let slot = this.floats[0];
    for (let index = 0; index < this.floats.length; index += 1) {
      const candidate = this.floats[index];
      if (!candidate.active) {
        slot = candidate;
        break;
      }
    }
    slot.active = true;
    slot.elapsed = 0;
    slot.duration = 950 + strength * 300;
    slot.drift = 0.026;
    slot.view.visible = true;
    slot.view.position.set(x, y);
    slot.view.alpha = 1;
    slot.label.text = `-${damage}`;
    slot.label.style.fill = ELEMENT_CORE[element];
    slot.label.style.fontSize = Math.round(26 + strength * 14);
    const glow = slot.view.children[0] as Sprite;
    glow.tint = ELEMENT_COLORS[element];
    glow.scale.set(1.6 + strength * 0.8);
  }

  // Slot pickup scans by index rather than `.find`: hits call this several times
  // and a throwaway closure per call is an allocation in the hot path.
  private takeBolt(): BoltSlot {
    for (let index = 0; index < this.bolts.length; index += 1) {
      const slot = this.bolts[index];
      if (!slot.active) return slot;
    }
    const recycled = this.bolts.shift() as BoltSlot;
    this.bolts.push(recycled);
    return recycled;
  }

  private takeImpact(): ImpactSlot {
    for (let index = 0; index < this.impacts.length; index += 1) {
      const slot = this.impacts[index];
      if (!slot.active) return slot;
    }
    const recycled = this.impacts.shift() as ImpactSlot;
    this.impacts.push(recycled);
    return recycled;
  }

  private wave(): WaveSlot {
    for (let index = 0; index < this.waves.length; index += 1) {
      const slot = this.waves[index];
      if (!slot.active) return slot;
    }
    const recycled = this.waves.shift() as WaveSlot;
    this.waves.push(recycled);
    return recycled;
  }
}

export interface BoltLanded {
  seq: number;
  /** The caster's spell cursor at launch, so the impact art matches the cast. */
  spellIndex: number;
  attackerId: string;
  targetId: string;
  element: Element;
  damage: number;
  eliminated: boolean;
  x: number;
  y: number;
}
