import type { Element } from '../shared/protocol';

/** Element identity used by both the DOM layer (CSS/hex) and PIXI (numbers). */
export const ELEMENT_COLORS: Record<Element, number> = {
  arcane: 0x9f92ff,
  fire: 0xff8a4c,
  ice: 0x62d3ff,
  storm: 0xe6ff5c,
};

export const ELEMENT_CSS: Record<Element, string> = {
  arcane: '#9f92ff',
  fire: '#ff8a4c',
  ice: '#62d3ff',
  storm: '#e6ff5c',
};

export const ELEMENT_CAST_LABELS: Record<Element, string> = {
  arcane: '奥术结界展开',
  fire: '烈焰爆裂',
  ice: '寒霜凝结',
  storm: '雷光贯穿',
};

/**
 * Deep shade of each element. Used for the shadow under a caster and for the
 * low-alpha bodies of impact shapes, so bright cores stay legible against a
 * dark arena without ever flooding the screen.
 */
export const ELEMENT_DEEP: Record<Element, number> = {
  arcane: 0x3d3184,
  fire: 0x8f2c0c,
  ice: 0x1b5c85,
  storm: 0x8c9420,
};

/**
 * Near-white core tint. Every impact keeps its peak brightness inside a small
 * shape instead of a full-screen flash, which is what keeps the arena safe for
 * photosensitivity while still reading as "a hit landed".
 */
export const ELEMENT_CORE: Record<Element, number> = {
  arcane: 0xeee9ff,
  fire: 0xffdcae,
  ice: 0xddf4ff,
  storm: 0xf6ffc4,
};
