import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';

const BAR_HEIGHT = 11;
const BAR_WIDTH_MAX = 240;
const BAR_WIDTH_MIN = 84;

/**
 * The honest part of a fighter: the coloured fill is always the authoritative
 * health from the snapshot, while the pale "catch-up" bar behind it keeps the
 * previous value and drains towards it, so a hit is legible even when the
 * snapshot that carried it arrived together with the next one. Nothing here
 * decides damage; it only reflects the room. The bar never rotates with the body:
 * a bar that tips with its owner is unreadable exactly when it matters most.
 */
export class FighterBar {
  readonly view = new Container();

  private readonly seat = new Graphics();
  private readonly frame = new Graphics();
  private readonly back: Sprite;
  private readonly ghost: Sprite;
  private readonly fill: Sprite;
  private readonly gloss: Sprite;

  private fillRatio = 1;
  private ghostRatio = 1;
  private barScale = 1;

  constructor(
    private readonly element: Element,
    private readonly flashTint: number,
  ) {
    this.back = new Sprite(Texture.WHITE);
    this.back.anchor.set(0, 0.5);
    this.back.tint = 0x191430;
    this.back.alpha = 0.9;

    this.ghost = new Sprite(Texture.WHITE);
    this.ghost.anchor.set(0, 0.5);
    this.ghost.tint = flashTint;

    this.fill = new Sprite(Texture.WHITE);
    this.fill.anchor.set(0, 0.5);
    this.fill.tint = ELEMENT_COLORS[element];

    this.gloss = new Sprite(Texture.WHITE);
    this.gloss.anchor.set(0, 0.5);
    this.gloss.tint = ELEMENT_CORE[element];
    this.gloss.alpha = 0.5;

    this.view.addChild(this.seat, this.back, this.ghost, this.fill, this.gloss, this.frame);
  }

  layout(maxWidth: number, barOffsetY: number): void {
    const barWidth = Math.max(BAR_WIDTH_MIN, Math.min(BAR_WIDTH_MAX, maxWidth * 0.92));
    const barX = -barWidth / 2;
    const baseScale = barWidth / Math.max(1, this.back.texture.width);
    const baseHeight = BAR_HEIGHT / Math.max(1, this.back.texture.height);
    this.barScale = baseScale;
    this.back.position.set(barX, barOffsetY);
    this.ghost.position.set(barX, barOffsetY);
    this.fill.position.set(barX, barOffsetY);
    this.gloss.position.set(barX, barOffsetY - BAR_HEIGHT * 0.28);
    this.back.scale.set(baseScale, baseHeight);
    this.gloss.scale.set(baseScale, baseHeight * 0.34);

    // Drawn under the fill sprites: a dark seat so the bar reads over any part
    // of the painted arena, without covering the fill itself.
    this.seat
      .clear()
      .roundRect(barX - 6, barOffsetY - BAR_HEIGHT / 2 - 6, barWidth + 12, BAR_HEIGHT + 12, 5)
      .fill({ color: 0x0a0716, alpha: 0.72 })
      .roundRect(barX - 4, barOffsetY - BAR_HEIGHT / 2 - 4, barWidth + 8, BAR_HEIGHT + 8, 4)
      .fill({ color: 0x1b1533, alpha: 0.92 });

    this.frame
      .clear()
      .roundRect(barX - 4, barOffsetY - BAR_HEIGHT / 2 - 4, barWidth + 8, BAR_HEIGHT + 8, 4)
      .stroke({ width: 1.5, color: 0x8a7ec8, alpha: 0.95 })
      .roundRect(barX - 6, barOffsetY - BAR_HEIGHT / 2 - 6, barWidth + 12, BAR_HEIGHT + 12, 5)
      .stroke({ width: 1, color: 0x2a2247, alpha: 1 });
    // Quarter ticks, then a gem at each end so the frame matches the arena's craft.
    for (let tick = 1; tick < 4; tick += 1) {
      const tickX = barX + (barWidth * tick) / 4;
      this.frame
        .moveTo(tickX, barOffsetY - BAR_HEIGHT / 2)
        .lineTo(tickX, barOffsetY + BAR_HEIGHT / 2)
        .stroke({ width: 1, color: 0x0d0a18, alpha: 0.55 });
    }
    this.frame
      .poly([
        barX - 9,
        barOffsetY,
        barX - 3,
        barOffsetY - 6,
        barX + 3,
        barOffsetY,
        barX - 3,
        barOffsetY + 6,
      ])
      .fill({ color: this.flashTint, alpha: 0.9 })
      .poly([
        barX + barWidth + 9,
        barOffsetY,
        barX + barWidth + 3,
        barOffsetY - 6,
        barX + barWidth - 3,
        barOffsetY,
        barX + barWidth + 3,
        barOffsetY + 6,
      ])
      .fill({ color: this.flashTint, alpha: 0.9 });
  }

  /**
   * Takes the authoritative health ratio, clamped by the caller. Returns true when
   * the loss lands as a hit — a drop that is not instant; `instant` skips the
   * catch-up animation and snaps the pale bar to the new value.
   */
  applyHealth(ratio: number, instant: boolean): boolean {
    let hit = false;
    if (ratio < this.fillRatio && !instant) {
      hit = true;
    } else if (instant || ratio >= this.fillRatio) {
      this.ghostRatio = ratio;
    }
    this.fillRatio = ratio;
    return hit;
  }

  catchUp(deltaMS: number): void {
    if (this.ghostRatio > this.fillRatio) {
      const gap = this.ghostRatio - this.fillRatio;
      const step = Math.max(gap * Math.min(1, deltaMS / 260), deltaMS * 0.00016);
      this.ghostRatio = Math.max(this.fillRatio, this.ghostRatio - step);
    } else {
      this.ghostRatio = this.fillRatio;
    }
  }

  paint(): void {
    const base = this.barScale;
    const heightScale = this.back.scale.y;
    this.ghost.scale.set(base * Math.max(0.0001, this.ghostRatio), heightScale);
    this.fill.scale.set(base * Math.max(0.0001, this.fillRatio), heightScale);
    this.fill.tint = this.fillRatio <= 0.25 ? 0xff6d6d : ELEMENT_COLORS[this.element];
    this.ghost.alpha = this.ghostRatio > this.fillRatio ? 0.85 : 0;
  }
}
