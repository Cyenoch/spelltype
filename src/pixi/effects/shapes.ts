import { Graphics, type Application, type Texture } from 'pixi.js';
import { ELEMENT_ORDER } from '../assets';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';

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
