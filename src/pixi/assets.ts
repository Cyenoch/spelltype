import type { Element } from '../../shared/protocol';

/**
 * 静态资源从应用基准路径提供（`import.meta.env.BASE_URL`，本单源应用恒为 `/`）。
 * Vite 会重写真实 CSS 中的 `url()` 与 index.html 中的链接，但 TypeScript 字符串常量绕过该管线 ——
 * 因此这里的每个 URL 都显式拼接基准路径。字面量的前导斜杠会被剥除，
 * 使与基准路径（始终以 `/` 结尾）的衔接处不会出现双斜杠。
 */
const BASE_URL = import.meta.env.BASE_URL;
const asset = (path: string): string => `${BASE_URL}${path.replace(/^\/+/, '')}`;

/**
 * 静态资源的唯一注册表。生成的美术资源位于 public/assets/ 下，
 * 与手写矢量兜底资源并列；每个交付文件的确切制作方式
 * （生成来源还是本地衍生资源）见 public/assets/provenance.json。
 */
export const ASSETS = {
  background: asset('/assets/bg/academy-hall.webp'),
  backgroundFallback: asset('/assets/bg/academy.svg'),
  sigil: asset('/assets/sigil.svg'),
  brandSeal: asset('/assets/ui/seal.svg'),
  spark: asset('/assets/effects/spark.svg'),
  avatars: [
    asset('/assets/avatars/seat-1.webp'),
    asset('/assets/avatars/seat-2.webp'),
    asset('/assets/avatars/seat-3.webp'),
    asset('/assets/avatars/seat-4.webp'),
  ],
  avatarFallbacks: [
    asset('/assets/avatars/seat-1.svg'),
    asset('/assets/avatars/seat-2.svg'),
    asset('/assets/avatars/seat-3.svg'),
    asset('/assets/avatars/seat-4.svg'),
  ],
  elementGlyphs: {
    arcane: asset('/assets/elements/arcane.svg'),
    fire: asset('/assets/elements/fire.svg'),
    ice: asset('/assets/elements/ice.svg'),
    storm: asset('/assets/elements/storm.svg'),
  } satisfies Record<Element, string>,
  /** 竞技场背景图，按对局轮换。索引 0..3。 */
  arenas: [
    asset('/assets/arenas/arena-1.webp'),
    asset('/assets/arenas/arena-2.webp'),
    asset('/assets/arenas/arena-3.webp'),
    asset('/assets/arenas/arena-4.webp'),
  ],
  /**
   * 带真实透明通道的全身斗士立绘，按席位 slot 索引。
   * slot 0 = arcane（奥术），1 = fire（火焰），2 = ice（冰霜），3 = storm（风暴）。
   */
  characters: [
    asset('/assets/characters/slot-0-arcane.webp'),
    asset('/assets/characters/slot-1-fire.webp'),
    asset('/assets/characters/slot-2-ice.webp'),
    asset('/assets/characters/slot-3-storm.webp'),
  ],
  /** 每个元素四张咒文符印，按 spellIndex % 4 索引。 */
  spellIcons: {
    arcane: [
      asset('/assets/spells/arcane-1.webp'),
      asset('/assets/spells/arcane-2.webp'),
      asset('/assets/spells/arcane-3.webp'),
      asset('/assets/spells/arcane-4.webp'),
    ],
    fire: [
      asset('/assets/spells/fire-1.webp'),
      asset('/assets/spells/fire-2.webp'),
      asset('/assets/spells/fire-3.webp'),
      asset('/assets/spells/fire-4.webp'),
    ],
    ice: [
      asset('/assets/spells/ice-1.webp'),
      asset('/assets/spells/ice-2.webp'),
      asset('/assets/spells/ice-3.webp'),
      asset('/assets/spells/ice-4.webp'),
    ],
    storm: [
      asset('/assets/spells/storm-1.webp'),
      asset('/assets/spells/storm-2.webp'),
      asset('/assets/spells/storm-3.webp'),
      asset('/assets/spells/storm-4.webp'),
    ],
  } satisfies Record<Element, readonly string[]>,
  /** 每个元素四种命中特效，按 spellIndex % 4 索引。带 Alpha 通道的 WebP。 */
  combatFx: {
    arcane: [
      asset('/assets/combat-fx/arcane-1.webp'),
      asset('/assets/combat-fx/arcane-2.webp'),
      asset('/assets/combat-fx/arcane-3.webp'),
      asset('/assets/combat-fx/arcane-4.webp'),
    ],
    fire: [
      asset('/assets/combat-fx/fire-1.webp'),
      asset('/assets/combat-fx/fire-2.webp'),
      asset('/assets/combat-fx/fire-3.webp'),
      asset('/assets/combat-fx/fire-4.webp'),
    ],
    ice: [
      asset('/assets/combat-fx/ice-1.webp'),
      asset('/assets/combat-fx/ice-2.webp'),
      asset('/assets/combat-fx/ice-3.webp'),
      asset('/assets/combat-fx/ice-4.webp'),
    ],
    storm: [
      asset('/assets/combat-fx/storm-1.webp'),
      asset('/assets/combat-fx/storm-2.webp'),
      asset('/assets/combat-fx/storm-3.webp'),
      asset('/assets/combat-fx/storm-4.webp'),
    ],
  } satisfies Record<Element, readonly string[]>,
} as const;

/**
 * StyleX 会静态编译 `create()` 中的值，因此由 `BASE_URL` 拼出的模板字符串无法出现在其中。
 * 竞技场背景（排队页与大厅）改为通过这个自定义属性获取图片图层；
 * 在启动时、任何此类界面渲染之前调用一次即可。
 */
export function installAssetBase(): void {
  document.documentElement.style.setProperty(
    '--spelltype-arena-image',
    `url("${ASSETS.arenas[0]}")`,
  );
}

export const SEAT_LIMIT = 4;

export const ELEMENT_ORDER = ['arcane', 'fire', 'ice', 'storm'] as const;

function wrap(index: number, length: number): number {
  return ((Math.trunc(index) % length) + length) % length;
}

export function avatarForSlot(slot: number): string {
  return ASSETS.avatars[wrap(slot, SEAT_LIMIT)] ?? ASSETS.avatars[0];
}

export function avatarFallbackForSlot(slot: number): string {
  return ASSETS.avatarFallbacks[wrap(slot, SEAT_LIMIT)] ?? ASSETS.avatarFallbacks[0];
}

export function elementGlyph(element: Element): string {
  return ASSETS.elementGlyphs[element] ?? ASSETS.elementGlyphs.arcane;
}

/** 指定席位 slot 的全身斗士立绘；若房间席位曾超过四个则循环取用。 */
export function characterForSlot(slot: number): string {
  return ASSETS.characters[wrap(slot, ASSETS.characters.length)] ?? ASSETS.characters[0];
}

/** 对局的竞技场背景图，按索引循环取用。 */
export function arenaFor(index: number): string {
  return ASSETS.arenas[wrap(index, ASSETS.arenas.length)] ?? ASSETS.arenas[0];
}

/** 指定元素的咒文符印，按 spellIndex 循环取用。 */
export function spellIconFor(element: Element, index: number): string {
  const icons = ASSETS.spellIcons[element] ?? ASSETS.spellIcons.arcane;
  return icons[wrap(index, icons.length)] ?? icons[0];
}

/** 指定元素的命中特效，按 spellIndex 循环取用。 */
export function combatFxFor(element: Element, index: number): string {
  const fx = ASSETS.combatFx[element] ?? ASSETS.combatFx.arcane;
  return fx[wrap(index, fx.length)] ?? fx[0];
}
