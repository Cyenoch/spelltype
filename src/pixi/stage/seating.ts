import type { Fighter } from '../fighter/fighter';

/** Where one seat sits and how much room its fighter actually took, in host pixels. */
export interface SeatGeometry {
  x: number;
  feetY: number;
  height: number;
  width: number;
  present: boolean;
}

export interface Seating {
  /** One entry per seat, in slot order. */
  readonly geometry: SeatGeometry[];
  /**
   * Lays the present seats out in equal columns and fits each fighter's art.
   * False when nobody is seated, so the caller can skip everything that anchors
   * to a fighter.
   */
  layout(width: number, height: number, present: readonly number[]): boolean;
  /** The fighter's chest anchor: where tethers, glyphs and impacts aim. */
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
    geometry,

    layout(width: number, height: number, present: readonly number[]): boolean {
      for (let slot = 0; slot < geometry.length; slot += 1) geometry[slot].present = false;
      for (const slot of present) geometry[slot].present = true;
      if (present.length === 0) return false;

      const inset = width * 0.06;
      const span = Math.max(1, width - inset * 2);
      const columnWidth = span / present.length;
      // Leave the raised damage segment visible on both sides of the feet bar.
      const feetY = height - Math.max(32, height * 0.08);
      const bodyHeight = Math.max(1, feetY - height * 0.1);
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
        // The drawn box, not the nominal one: a width-limited column would
        // otherwise leave every anchor above the character's head.
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
