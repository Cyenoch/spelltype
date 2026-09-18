import { Graphics } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE, ELEMENT_DEEP } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';

/** Ticks in the casting dial that light up as the accepted prefix grows. */
const CHARGE_TICKS = 18;

/**
 * The casting dial above the caster's head. It sits outside the posed body group,
 * so it stays upright while the body is shoved around, and it is the one patch of
 * the scene that is always empty — the typing read never crosses the artwork.
 */
export class FighterCharge {
  readonly view = new Graphics();

  private chargeRingRadius = 30;
  private chargeRatio = 0;
  private drawnCharge = -1;

  constructor(private readonly element: Element) {}

  /** Sits the dial above the head; the next paint is forced. */
  layout(bodyHeight: number): void {
    this.view.scale.set(1, 1);
    this.view.position.set(0, -bodyHeight - 30);
    this.chargeRingRadius = 22;
    this.drawnCharge = -1;
  }

  /** Accepted typing ratio, filtered through the 0.004 deadband. */
  accept(ratio: number): void {
    const next = Math.max(0, Math.min(1, ratio));
    if (Math.abs(next - this.chargeRatio) < 0.004) return;
    this.chargeRatio = next;
  }

  /** Repaints the dial when the ratio has moved since the last repaint. */
  paint(): void {
    if (Math.abs(this.chargeRatio - this.drawnCharge) < 0.004) return;
    this.drawnCharge = this.chargeRatio;

    // A compact halo of ticks above the caster: the accepted prefix lights it up
    // tick by tick, which reads instantly and never covers the artwork.
    const radius = this.chargeRingRadius;
    const lit = Math.round(this.chargeRatio * CHARGE_TICKS);
    this.view.clear();
    this.view
      .circle(0, 0, radius)
      .stroke({ width: 1.5, color: ELEMENT_DEEP[this.element], alpha: 0.6 });
    if (this.chargeRatio > 0) {
      const end = -Math.PI / 2 + Math.PI * 2 * this.chargeRatio;
      this.view.arc(0, 0, radius, -Math.PI / 2, end).stroke({
        width: 7,
        color: ELEMENT_COLORS[this.element],
        alpha: 0.35,
        cap: 'round',
      });
      this.view.arc(0, 0, radius, -Math.PI / 2, end).stroke({
        width: 3,
        color: ELEMENT_CORE[this.element],
        alpha: 0.95,
        cap: 'round',
      });
    }
    for (let index = 0; index < CHARGE_TICKS; index += 1) {
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / CHARGE_TICKS;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const on = index < lit;
      this.view
        .moveTo(cos * (radius + 5), sin * (radius + 5))
        .lineTo(cos * (radius + (on ? 13 : 8)), sin * (radius + (on ? 13 : 8)))
        .stroke({
          width: on ? 3 : 1.5,
          color: on ? ELEMENT_CORE[this.element] : ELEMENT_DEEP[this.element],
          alpha: on ? 0.95 : 0.4,
          cap: 'round',
        });
    }
  }
}
