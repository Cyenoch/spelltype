import type { Element } from '../../shared/protocol';

/** DOM 层（CSS/十六进制文本）与 PIXI（数值）共用的元素颜色标识。 */
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
 * 各元素的深色底色。用于施法者脚下的阴影以及受击图形的低透明度主体，
 * 确保高亮的核心在暗色竞技场背景下清晰可辨，同时避免过亮炫目充满整个画面。
 */
export const ELEMENT_DEEP: Record<Element, number> = {
  arcane: 0x3d3184,
  fire: 0x8f2c0c,
  ice: 0x1b5c85,
  storm: 0x8c9420,
};

/**
 * 接近纯白的核心高光色。所有受击命中效果都将最高亮度控制在小尺寸图形内部，
 * 而非全屏闪烁，从而在确保视觉表现清晰传递“成功命中”的同时避免光敏性刺激。
 */
export const ELEMENT_CORE: Record<Element, number> = {
  arcane: 0xeee9ff,
  fire: 0xffdcae,
  ice: 0xddf4ff,
  storm: 0xf6ffc4,
};
