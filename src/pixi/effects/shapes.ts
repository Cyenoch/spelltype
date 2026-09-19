import { Graphics, type Application, type Texture } from 'pixi.js';
import { ELEMENT_ORDER } from '../assets';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';

/**
 * 元素效果形状在启动时一次性绘制为纹理，之后每帧只做定位、缩放与着色。
 * 这使整个效果图层保持为精灵批次（不做逐帧矢量重建，也不使用滤镜），
 * 并让高 DPI 屏幕上的顶点计算量保持极小。
 */
export interface FxTextures {
  /** 柔和的径向光斑：光环、枪口辉光、命中闪光、光柱。 */
  glow: Texture;
  /** 细环形：冲击波与命中光环。 */
  ring: Texture;
  bolt: Record<Element, Texture>;
  shard: Record<Element, Texture>;
  rune: Record<Element, Texture>;
  /** 窄水晶柱，使用时着色。 */
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
 * 以纯白色绘制某一元素的火花形状，使其每个使用者都通过着色来决定颜色：
 * 同一形状既服务于竞技场的粒子池，也服务于文本叠加层的火花。
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
  // 以纯白色绘制，让使用者的着色完全决定颜色：
  // 同一形状既服务于元素命中，也服务于金色胜利印记。
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

/** 一次性构建全部元素形状。返回由调用方持有的普通 `Texture`。 */
export function createFxTextures(app: Application): FxTextures {
  const generate = (build: (g: Graphics) => void): Texture => {
    const graphics = new Graphics();
    build(graphics);
    // 锚点在每个精灵上设置，因此生成的画框保持为形状的原始边界。
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

/** 释放已生成的形状；舞台在销毁时恰好调用一次。 */
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
