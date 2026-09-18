import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';

const BAR_HEIGHT = 11;
const BAR_WIDTH_MAX = 240;
const BAR_WIDTH_MIN = 84;
/** Visual only: full-health hits read slightly larger; numeric HP stays authoritative. */
const HEALTH_CURVE = 1.1;
const DROP_HOLD_MS = 140;
const DROP_DURATION_MS = 480;
const FLASH_DURATION_MS = 260;

/**
 * The loss segment flashes above the frame, then shrinks away while the main fill
 * follows after a brief hold. Widths use a subtle curve, never the combat rules.
 * Authoritative HP and accessible numeric readouts remain exact. The bar stays
 * horizontal even when its fighter recoils or falls.
 */
export class FighterBar {
  readonly view = new Container();

  private readonly seat = new Graphics();
  private readonly frame = new Graphics();
  private readonly back: Sprite;
  private readonly damageFlash: Sprite;
  private readonly fill: Sprite;
  private readonly gloss: Sprite;

  private healthRatio = 1;
  private targetRatio = 1;
  private fillRatio = 1;
  private dropFrom = 1;
  private dropElapsed = DROP_HOLD_MS + DROP_DURATION_MS;
  private flashFrom = 1;
  private flashTo = 1;
  private flashElapsed = FLASH_DURATION_MS;
  private barScale = 1;
  private barWidth = BAR_WIDTH_MAX;

  constructor(
    private readonly element: Element,
    private readonly flashTint: number,
  ) {
    this.back = new Sprite(Texture.WHITE);
    this.back.anchor.set(0, 0.5);
    this.back.tint = 0x191430;
    this.back.alpha = 0.9;

    this.damageFlash = new Sprite(Texture.WHITE);
    this.damageFlash.anchor.set(0.5, 0.5);
    this.damageFlash.visible = false;

    this.fill = new Sprite(Texture.WHITE);
    this.fill.anchor.set(0, 0.5);
    this.fill.tint = ELEMENT_COLORS[element];

    this.gloss = new Sprite(Texture.WHITE);
    this.gloss.anchor.set(0, 0.5);
    this.gloss.tint = ELEMENT_CORE[element];
    this.gloss.alpha = 0.5;

    this.view.addChild(this.seat, this.back, this.fill, this.gloss, this.frame, this.damageFlash);
  }

  layout(maxWidth: number, barOffsetY: number): void {
    const barWidth = Math.max(BAR_WIDTH_MIN, Math.min(BAR_WIDTH_MAX, maxWidth * 0.92));
    const barX = -barWidth / 2;
    const baseScale = barWidth / Math.max(1, this.back.texture.width);
    const baseHeight = BAR_HEIGHT / Math.max(1, this.back.texture.height);
    this.barScale = baseScale;
    this.barWidth = barWidth;
    this.back.position.set(barX, barOffsetY);
    this.damageFlash.position.set(barX, barOffsetY);
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
   * Only a new authoritative loss starts a flash. Repeated snapshots must not
   * erase it or restart its hold. Initial state, healing/rematch and reduced
   * motion snap immediately, without manufacturing damage.
   */
  applyHealth(ratio: number, instant: boolean): boolean {
    const previous = this.healthRatio;
    if (!instant && ratio === previous) return false;
    const target = ratio ** HEALTH_CURVE;
    this.healthRatio = ratio;
    if (instant || ratio >= previous) {
      this.targetRatio = target;
      this.fillRatio = target;
      this.dropFrom = target;
      this.dropElapsed = DROP_HOLD_MS + DROP_DURATION_MS;
      this.flashElapsed = FLASH_DURATION_MS;
      return false;
    }

    // A second hit retargets the existing drop without adding another full hold.
    this.dropElapsed =
      this.fillRatio > this.targetRatio ? Math.min(this.dropElapsed, DROP_HOLD_MS) : 0;
    this.dropFrom = this.fillRatio;
    this.flashFrom = this.targetRatio;
    this.flashTo = target;
    this.flashElapsed = 0;
    this.targetRatio = target;
    return true;
  }

  catchUp(deltaMS: number): void {
    this.flashElapsed = Math.min(FLASH_DURATION_MS, this.flashElapsed + deltaMS);
    if (this.fillRatio <= this.targetRatio) return;
    this.dropElapsed = Math.min(DROP_HOLD_MS + DROP_DURATION_MS, this.dropElapsed + deltaMS);
    const progress = Math.max(0, this.dropElapsed - DROP_HOLD_MS) / DROP_DURATION_MS;
    this.fillRatio = this.targetRatio + (this.dropFrom - this.targetRatio) * (1 - progress) ** 3;
  }

  paint(): void {
    const base = this.barScale;
    const heightScale = this.back.scale.y;
    this.fill.scale.set(base * this.fillRatio, heightScale);
    this.fill.visible = this.fillRatio > 0;
    this.fill.tint = this.healthRatio <= 0.25 ? 0xff6d6d : ELEMENT_COLORS[this.element];
    this.gloss.scale.x = base * this.fillRatio;
    this.gloss.visible = this.fill.visible;

    const flash = 1 - this.flashElapsed / FLASH_DURATION_MS;
    this.damageFlash.visible = flash > 0 && this.flashFrom > this.flashTo;
    if (!this.damageFlash.visible) return;
    this.damageFlash.x = this.back.x + this.barWidth * (this.flashFrom + this.flashTo) * 0.5;
    this.damageFlash.scale.set(
      base * (this.flashFrom - this.flashTo) * (0.7 + flash * 0.3),
      heightScale * 2.8 * flash ** 2,
    );
    this.damageFlash.alpha = flash;
    this.damageFlash.tint = this.flashElapsed < 70 ? 0xffffff : 0xffedaa;
  }
}
