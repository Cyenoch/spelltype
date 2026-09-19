import type { Fighter } from '../fighter/fighter';

/**
 * 竞技场美术可绘制区域的画布局部下边界。DOM 顶部标签（名称、标记、进度读数）
 * 悬浮在画布顶部约 82–94px 范围内，
 * 因此斗士、其蓄力符文以及伤害飘字的上升都从该条带之下开始。
 * 采用单一常量：标签堆栈按像素定尺寸，而不是按画布百分比。
 */
export const TOP_RESERVED_PX = 96;

/** 某个席位的落点以及其斗士实际占用的空间，单位宿主像素。 */
export interface SeatGeometry {
  x: number;
  feetY: number;
  height: number;
  width: number;
  present: boolean;
}

export interface Seating {
  /**
   * 画布局部坐标下的保留顶部条带：竞技场绘制的一切 ——
   * 身体、蓄力符文、伤害飘字 —— 都停留在该 y 值或其下方。
   */
  readonly topBand: number;
  /** 每个席位一项，按席位顺序排列。 */
  readonly geometry: SeatGeometry[];
  /**
   * 将当前在场的席位排布为等宽列，并适配每个斗士的立绘。
   * 无人入座时返回 false，使调用方能跳过一切以斗士为锚点的内容。
   */
  layout(width: number, height: number, present: readonly number[]): boolean;
  /** 斗士的胸口锚点：连接光束、字形与命中效果的瞄准位置。 */
  chest(slot: number, out: { x: number; y: number }): void;
}

export function createSeating(fighters: readonly Fighter[]): Seating {
  const geometry: SeatGeometry[] = fighters.map(() => ({
    x: 0,
    feetY: 0,
    height: 0,
    width: 0,
    present: false,
  }));

  return {
    topBand: TOP_RESERVED_PX,

    geometry,

    layout(width: number, height: number, present: readonly number[]): boolean {
      for (let slot = 0; slot < geometry.length; slot += 1) geometry[slot].present = false;
      for (const slot of present) geometry[slot].present = true;
      if (present.length === 0) return false;

      const inset = width * 0.06;
      const span = Math.max(1, width - inset * 2);
      const columnWidth = span / present.length;
      // 让抬升的伤害区段在脚部进度条两侧都保持可见。
      const feetY = height - Math.max(32, height * 0.08);
      // 身体从保留的标签条带之下开始，而不是从某个画布比例开始：
      // 正是按比例留出的边距，让过去那种头顶刻度盘与伤害飘字在矮画布上
      // 爬进了顶部边缘、甚至越出边缘。
      const bodyHeight = Math.max(1, feetY - this.topBand);
      const barOffsetY = Math.max(14, Math.min(26, height * 0.04));

      present.forEach((slot, index) => {
        const x = inset + columnWidth * (index + 0.5);
        const seat = geometry[slot];
        const box = fighters[slot].layout({
          x,
          feetY,
          bodyHeight,
          maxWidth: columnWidth * 0.86,
          barOffsetY,
          baselineSpace: Math.max(18, height - feetY),
        });
        // 采用实际绘制的包围盒，而非标称值：
        // 否则一个受宽度限制的列会让所有锚点都跑到角色头顶之上。
        seat.x = x;
        seat.feetY = feetY;
        seat.height = box.height;
        seat.width = box.width;
      });
      return true;
    },

    chest(slot: number, out: { x: number; y: number }): void {
      const seat = geometry[slot];
      out.x = seat.x;
      out.y = seat.feetY - seat.height * 0.62;
    },
  };
}
