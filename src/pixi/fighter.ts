import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import { ELEMENT_ORDER } from '../assets';
import { ELEMENT_COLORS, ELEMENT_CORE, ELEMENT_DEEP } from '../elements';
import type { Element } from '../../shared/protocol';

export interface FighterState {
  slot: number;
  connected: boolean;
  self: boolean;
  /** 0..1 of the player's max health. */
  hpRatio: number;
  eliminated: boolean;
  rank: number | null;
}

/** Where a fighter root sits and how much room it has, in host pixels. */
export interface FighterLayout {
  x: number;
  /** Host y of the fighter's feet. */
  feetY: number;
  bodyHeight: number;
  maxWidth: number;
  /** Local y for the health bar, in pixels below the feet. */
  barOffsetY: number;
  /** How much vertical room is left below the feet, for the ground pool. */
  baselineSpace: number;
}

/** The box a fighter actually occupies after the art has been fitted. */
export interface FighterBox {
  height: number;
  width: number;
}

/** Art one fighter draws with. The silhouette must match `body` pixel for pixel. */
export interface FighterTextures {
  body: Texture;
  glow: Texture;
  ring: Texture;
  /**
   * The body art precomputed as a flat white fill of its own alpha. The KO shroud
   * and the hit wash are that shape, so no mask — and therefore no per-frame
   * filter pass — is needed to clip a flat fill to the character.
   */
  silhouette: Texture;
}

const BAR_HEIGHT = 11;
/** Ticks in the casting dial that light up as the accepted prefix grows. */
const CHARGE_TICKS = 18;
const BAR_WIDTH_MAX = 240;
const BAR_WIDTH_MIN = 84;
const FLINCH_MS = 280;
const KO_MS = 900;
const KO_TINT = 0x585672;
/**
 * Radians the body tips over by when it is eliminated. Deliberately shallow: a
 * portrait sprite rotated flat becomes a slab as wide as the figure is tall,
 * which would sprawl across the neighbouring lane, so the collapse reads as a
 * crumple — small tilt, slight shrink, grey wash — instead of a full 90° rotation.
 */
const KO_TILT = 0.55;

/**
 * One full-body combatant: generated character art, an element aura, a ground
 * pool of its own element and an interpolated health bar.
 *
 * Two groups matter. The body group (aura, art, ground, charge ring) takes the
 * poses — flinch, tip-over, victory — while the health bar group never rotates:
 * a bar that tips with its owner is unreadable exactly when it matters most.
 *
 * The bar is the honest part of the class: the coloured fill is always the
 * authoritative health from the snapshot, while the pale "catch-up" bar behind
 * it keeps the previous value and drains towards it, so a hit is legible even
 * when the snapshot that carried it arrived together with the next one. Nothing
 * here decides damage; it only reflects the room.
 */
export class Fighter {
  readonly view = new Container();
  readonly slot: number;
  readonly element: Element;

  private readonly bodyGroup = new Container();
  private readonly plate: Sprite;
  private readonly shadow: Sprite;
  private readonly ground: Sprite;
  private readonly aura: Sprite;
  private readonly rim: Sprite;
  private readonly veil: Sprite;
  private readonly body: Sprite;
  private readonly barBack: Sprite;
  private readonly barGhost: Sprite;
  private readonly barFill: Sprite;
  private readonly barGloss: Sprite;
  private readonly barSeat = new Graphics();
  private readonly barFrame = new Graphics();
  private readonly charge = new Graphics();

  private fillRatio = 1;
  private ghostRatio = 1;
  private chargeRatio = 0;
  private drawnCharge = -1;
  private barScale = 1;
  private chargeRingRadius = 30;
  private rimBaseHeight = 1;
  private rimBaseWidth = 1;
  private self = false;
  private active = true;
  private connected = true;
  private eliminated = false;
  private koPending = false;
  private victory = false;
  private flinch = 0;
  private flinchDirection = 1;
  private koClock = 0;
  private hitFlash = 0;
  private danger = 0;

  constructor(
    slot: number,
    textures: FighterTextures,
    /** Colour a hit flashes the silhouette with. */
    private readonly flashTint: number,
  ) {
    this.slot = slot;
    this.element = ELEMENT_ORDER[slot % ELEMENT_ORDER.length];
    const color = ELEMENT_COLORS[this.element];

    this.aura = new Sprite(textures.glow);
    this.aura.anchor.set(0.5);
    this.aura.blendMode = 'add';
    this.aura.tint = color;
    this.aura.alpha = 0.16;

    this.plate = new Sprite(textures.ring);
    this.plate.anchor.set(0.5);
    this.plate.blendMode = 'add';
    this.plate.tint = color;
    this.plate.alpha = 0.3;

    this.shadow = new Sprite(textures.glow);
    this.shadow.anchor.set(0.5);
    this.shadow.tint = 0x05030d;
    this.shadow.alpha = 0.62;

    // A pool of the fighter's own element under the feet: it is what stops the
    // character from reading as a cut-out pasted onto the arena floor.
    this.ground = new Sprite(textures.glow);
    this.ground.anchor.set(0.5);
    this.ground.blendMode = 'add';
    this.ground.tint = ELEMENT_DEEP[this.element];
    this.ground.alpha = 0.5;

    this.body = new Sprite(textures.body);
    this.body.anchor.set(0.5, 1);

    this.rim = new Sprite(textures.body);
    this.rim.anchor.set(0.5);
    this.rim.blendMode = 'add';
    this.rim.tint = ELEMENT_CORE[this.element];
    this.rim.alpha = 0.2;

    // Sits above the art and only appears when the fighter goes down: a flat
    // silhouette of the body in grey or, during a hit, in white. The silhouette is
    // precomputed white art, so the flat fill is clipped to the character without
    // a mask — a mask is a filter, and a filter pass per fighter per frame is a
    // lot to pay for a wash that is invisible most of the time.
    this.veil = new Sprite(textures.silhouette);
    this.veil.anchor.set(0.5, 1);
    this.veil.tint = 0xa6a3b8;
    this.veil.alpha = 0;
    // It only enters the render build while it has a wash to draw.
    this.veil.renderable = false;

    this.barBack = new Sprite(Texture.WHITE);
    this.barBack.anchor.set(0, 0.5);
    this.barBack.tint = 0x191430;
    this.barBack.alpha = 0.9;

    this.barGhost = new Sprite(Texture.WHITE);
    this.barGhost.anchor.set(0, 0.5);
    this.barGhost.tint = flashTint;

    this.barFill = new Sprite(Texture.WHITE);
    this.barFill.anchor.set(0, 0.5);
    this.barFill.tint = color;

    this.barGloss = new Sprite(Texture.WHITE);
    this.barGloss.anchor.set(0, 0.5);
    this.barGloss.tint = ELEMENT_CORE[this.element];
    this.barGloss.alpha = 0.5;

    const bars = new Container();
    bars.addChild(this.barSeat, this.barBack, this.barGhost, this.barFill, this.barGloss, this.barFrame);

    // Charge ring lives with the bars: it is a read on the player's own typing,
    // so it must stay upright while the body is being shoved around.
    const anchors = new Container();
    anchors.addChild(this.charge);

    this.bodyGroup.addChild(
      this.plate,
      this.shadow,
      this.ground,
      this.aura,
      this.rim,
      this.body,
      this.veil,
    );
    this.view.addChild(this.bodyGroup, bars, anchors);
  }

  /** True once this fighter has collapsed and is out of the match. */
  get isDown(): boolean {
    return this.eliminated;
  }

  get eliminationPending(): boolean {
    return this.koPending;
  }

  setSelf(self: boolean): void {
    this.self = self;
    this.charge.visible = self && !this.eliminated;
  }

  /** Hides a seat that has no occupant this match. */
  setActive(active: boolean): void {
    this.active = active;
    this.view.visible = active;
  }

  layout(layout: FighterLayout): FighterBox {
    const { x, feetY, bodyHeight, maxWidth, barOffsetY, baselineSpace } = layout;
    const texture = this.body.texture;
    const aspect = texture.width > 0 ? texture.width / texture.height : 0.5;
    // A narrow column can fit the art by width rather than by height; the caller
    // needs the box that was really drawn, or every anchor it derives (chest,
    // head, impact, damage float) drifts off the character.
    const drawnHeight = Math.min(bodyHeight, maxWidth / Math.max(0.001, aspect));
    const drawnWidth = drawnHeight * aspect;

    this.view.position.set(x, feetY);
    this.body.height = drawnHeight;
    this.body.width = drawnWidth;
    // The rim scales about the body's own centre: anchored at the feet its glow
    // would sit above the head and read as a second, ghosting figure.
    this.rim.height = drawnHeight * 1.06;
    this.rim.width = drawnWidth * 1.08;
    this.rim.y = -drawnHeight * 0.5;
    this.rimBaseHeight = drawnHeight;
    this.rimBaseWidth = drawnWidth;
    this.veil.height = drawnHeight;
    this.veil.width = drawnWidth;

    const auraSize = Math.max(drawnWidth, drawnHeight * 0.6) * 1.9;
    this.aura.width = auraSize;
    this.aura.height = auraSize;
    this.aura.y = -drawnHeight * 0.52;

    // Everything on the ground is flattened to fit the strip below the feet and
    // to stay clear of the neighbouring column.
    const flatHeight = Math.max(16, Math.min(drawnWidth * 0.28, baselineSpace * 1.4));
    const groundWidth = Math.min(drawnWidth * 1.2, maxWidth * 1.15);

    this.ground.width = groundWidth;
    this.ground.height = flatHeight;
    this.ground.y = -flatHeight * 0.25;

    this.shadow.width = Math.min(drawnWidth * 1.05, maxWidth);
    this.shadow.height = flatHeight * 0.5;
    this.shadow.x = flatHeight * 0.22;
    this.shadow.y = -flatHeight * 0.1;

    this.plate.width = groundWidth;
    this.plate.height = flatHeight * 0.5;
    this.plate.y = -flatHeight * 0.2;

    const barWidth = Math.max(BAR_WIDTH_MIN, Math.min(BAR_WIDTH_MAX, maxWidth * 0.92));
    const barX = -barWidth / 2;
    const baseScale = barWidth / Math.max(1, this.barBack.texture.width);
    const baseHeight = BAR_HEIGHT / Math.max(1, this.barBack.texture.height);
    this.barScale = baseScale;
    this.barBack.position.set(barX, barOffsetY);
    this.barGhost.position.set(barX, barOffsetY);
    this.barFill.position.set(barX, barOffsetY);
    this.barGloss.position.set(barX, barOffsetY - BAR_HEIGHT * 0.28);
    this.barBack.scale.set(baseScale, baseHeight);
    this.barGloss.scale.set(baseScale, baseHeight * 0.34);

    // Drawn under the fill sprites: a dark seat so the bar reads over any part
    // of the painted arena, without covering the fill itself.
    this.barSeat
      .clear()
      .roundRect(barX - 6, barOffsetY - BAR_HEIGHT / 2 - 6, barWidth + 12, BAR_HEIGHT + 12, 5)
      .fill({ color: 0x0a0716, alpha: 0.72 })
      .roundRect(barX - 4, barOffsetY - BAR_HEIGHT / 2 - 4, barWidth + 8, BAR_HEIGHT + 8, 4)
      .fill({ color: 0x1b1533, alpha: 0.92 });

    this.barFrame
      .clear()
      .roundRect(barX - 4, barOffsetY - BAR_HEIGHT / 2 - 4, barWidth + 8, BAR_HEIGHT + 8, 4)
      .stroke({ width: 1.5, color: 0x8a7ec8, alpha: 0.95 })
      .roundRect(barX - 6, barOffsetY - BAR_HEIGHT / 2 - 6, barWidth + 12, BAR_HEIGHT + 12, 5)
      .stroke({ width: 1, color: 0x2a2247, alpha: 1 });
    // Quarter ticks, then a gem at each end so the frame matches the arena's craft.
    for (let tick = 1; tick < 4; tick += 1) {
      const tickX = barX + (barWidth * tick) / 4;
      this.barFrame
        .moveTo(tickX, barOffsetY - BAR_HEIGHT / 2)
        .lineTo(tickX, barOffsetY + BAR_HEIGHT / 2)
        .stroke({ width: 1, color: 0x0d0a18, alpha: 0.55 });
    }
    this.barFrame
      .poly([barX - 9, barOffsetY, barX - 3, barOffsetY - 6, barX + 3, barOffsetY, barX - 3, barOffsetY + 6])
      .fill({ color: this.flashTint, alpha: 0.9 })
      .poly([barX + barWidth + 9, barOffsetY, barX + barWidth + 3, barOffsetY - 6, barX + barWidth - 3, barOffsetY, barX + barWidth + 3, barOffsetY + 6])
      .fill({ color: this.flashTint, alpha: 0.9 });

    // The casting halo lives above the caster's head: it is the one patch of the
    // scene that is always empty, so the typing read never crosses the artwork.
    this.charge.scale.set(1, 1);
    this.charge.position.set(0, -drawnHeight - 30);
    this.chargeRingRadius = 22;
    this.drawnCharge = -1;
    this.paint();
    return { height: drawnHeight, width: drawnWidth };
  }

  /** Applies authoritative state. `instant` skips the catch-up animation. */
  applyState(state: FighterState, instant: boolean, deferElimination = false): void {
    const next = Math.min(1, Math.max(0, state.hpRatio));
    if (next < this.fillRatio && !instant) {
      this.hitFlash = 1;
    } else if (instant || next >= this.fillRatio) {
      this.ghostRatio = next;
    }
    this.fillRatio = next;
    this.self = state.self;
    this.connected = state.connected;
    this.charge.visible = state.self && !state.eliminated;
    this.danger = 1 - next;
    this.view.visible = this.active;

    if (state.eliminated) {
      // The snapshot can land the killing blow before the projectile that caused
      // it has finished flying; the pose waits for the impact in that case.
      if (deferElimination && !this.eliminated) {
        this.koPending = true;
      } else {
        this.koPending = false;
        this.applyEliminated(true, instant);
      }
    } else {
      this.koPending = false;
      this.applyEliminated(false, instant);
    }
    this.paint();
  }

  /** Plays the deferred collapse now that the killing projectile has landed. */
  commitElimination(instant: boolean): void {
    if (!this.koPending) return;
    this.koPending = false;
    this.applyEliminated(true, instant);
  }

  private applyEliminated(eliminated: boolean, instant: boolean): void {
    if (eliminated === this.eliminated) return;
    this.eliminated = eliminated;
    if (!eliminated) {
      this.koClock = 0;
      this.bodyGroup.rotation = 0;
      this.bodyGroup.y = 0;
      // The collapse also shrinks the group; without this a fighter that comes
      // back (next match, rejoin) stays crumpled at the KO scale for good.
      this.bodyGroup.scale.set(1);
      this.body.tint = 0xffffff;
      this.body.alpha = 1;
      this.rim.blendMode = 'add';
      this.rim.tint = ELEMENT_CORE[this.element];
      this.rim.alpha = 0.2;
      this.rim.height = this.rimBaseHeight * 1.06;
      this.rim.width = this.rimBaseWidth * 1.08;
      this.veil.alpha = 0;
      this.veil.renderable = false;
      this.plate.alpha = 0.3;
      this.aura.alpha = 0.16;
      this.shadow.alpha = 0.62;
      return;
    }
    this.victory = false;
    this.charge.visible = false;
    this.veil.tint = 0xa6a3b8;
    this.veil.renderable = true;
    this.koClock = instant ? KO_MS : 0;
    this.applyKoPose();
  }

  private applyKoPose(): void {
    const direction = this.slot % 2 === 0 ? 1 : -1;
    const progress = Math.min(1, this.koClock / KO_MS);
    const eased = 1 - (1 - progress) * (1 - progress);
    const crumple = 1 - 0.12 * eased;
    this.bodyGroup.rotation = direction * KO_TILT * eased;
    this.bodyGroup.scale.set(crumple);
    // Rotating about the feet swings the body's width below the feet line, which
    // would sweep it through the health bar; the lift puts it back on the floor.
    const lift = (this.rimBaseWidth * 0.5 * Math.sin(KO_TILT) * crumple + 10) * eased;
    this.bodyGroup.y = -lift;
    this.body.tint = KO_TINT;
    this.body.alpha = 1;
    this.veil.alpha = 0.72 * eased;
    this.rim.alpha = 0;
    this.plate.alpha = 0.3 * (1 - eased);
    this.aura.alpha = 0;
    this.shadow.alpha = 0.62 - eased * 0.25;
  }

  /**
   * Visible reaction to a hit: a shove away from wherever the blow came from,
   * plus a white wash over the body (a multiply tint can only darken art, so the
   * veil sprite is what makes a hit read as brightness).
   */
  hit(strength: number, direction: number): void {
    if (this.eliminated) return;
    const scaled = 0.7 + Math.min(1, Math.max(0, strength)) * 0.5;
    this.flinch = FLINCH_MS * scaled;
    this.flinchDirection = direction >= 0 ? 1 : -1;
    this.hitFlash = 1;
    this.veil.tint = 0xffffff;
    this.veil.renderable = true;
  }

  /** Played when this fighter lands a blow of its own. */
  flourish(): void {
    this.hitFlash = Math.max(this.hitFlash, 0.4);
  }

  setVictory(active: boolean): void {
    this.victory = active;
    if (!active) this.aura.tint = ELEMENT_COLORS[this.element];
  }

  setCharge(ratio: number): void {
    const next = Math.max(0, Math.min(1, ratio));
    if (Math.abs(next - this.chargeRatio) < 0.004) return;
    this.chargeRatio = next;
  }

  update(deltaMS: number, pulse: number): void {
    if (this.ghostRatio > this.fillRatio) {
      const gap = this.ghostRatio - this.fillRatio;
      const step = Math.max(gap * Math.min(1, deltaMS / 260), deltaMS * 0.00016);
      this.ghostRatio = Math.max(this.fillRatio, this.ghostRatio - step);
    } else {
      this.ghostRatio = this.fillRatio;
    }

    let offsetX = 0;
    let wobble = 0;
    if (this.flinch > 0) {
      this.flinch = Math.max(0, this.flinch - deltaMS);
      const t = this.flinch / FLINCH_MS;
      const shove = t * Math.sin(t * Math.PI);
      offsetX += this.flinchDirection * 18 * shove;
      wobble = this.flinchDirection * 0.05 * shove;
    }
    if (this.bodyGroup.x !== offsetX) this.bodyGroup.x = offsetX;
    if (!this.eliminated) this.bodyGroup.rotation = wobble;

    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - deltaMS / 190);
      // The veil doubles as the hit wash while the fighter is standing; once the
      // fighter is down the collapse owns both its colour and its alpha, or the
      // shroud would stay white whenever the killing blow also landed a hit.
      if (!this.eliminated) {
        this.veil.renderable = true;
        this.veil.tint = 0xffffff;
        this.veil.alpha = 0.42 * this.hitFlash;
      }
    } else if (!this.eliminated && this.veil.alpha !== 0) {
      // The wash has run out: park the veil outside the build again.
      this.veil.alpha = 0;
      this.veil.renderable = false;
    }

    if (this.eliminated) {
      if (this.koClock < KO_MS) {
        this.koClock = Math.min(KO_MS, this.koClock + deltaMS);
        this.applyKoPose();
      }
    } else {
      // Low health makes the aura restless: a slow, deliberate swing, never a strobe.
      const agitation = 1 + this.danger * 1.6;
      const breath = 0.5 + 0.5 * Math.sin(pulse * agitation);
      this.aura.alpha = (0.12 + breath * 0.12) * (this.connected ? 1 : 0.4);
      this.plate.alpha = 0.24 + breath * 0.16;
      if (this.victory) {
        this.aura.alpha = 0.3 + breath * 0.2;
        this.aura.tint = 0xffd79a;
        this.bodyGroup.y = -6 - breath * 4;
      } else if (this.bodyGroup.y !== 0) {
        this.bodyGroup.y = 0;
      }
    }

    this.paint();
  }

  private paint(): void {
    const base = this.barScale;
    const heightScale = this.barBack.scale.y;
    this.barGhost.scale.set(base * Math.max(0.0001, this.ghostRatio), heightScale);
    this.barFill.scale.set(base * Math.max(0.0001, this.fillRatio), heightScale);
    this.barFill.tint = this.fillRatio <= 0.25 ? 0xff6d6d : ELEMENT_COLORS[this.element];
    this.barGhost.alpha = this.ghostRatio > this.fillRatio ? 0.85 : 0;

    if (!this.self || this.eliminated) return;
    if (Math.abs(this.chargeRatio - this.drawnCharge) < 0.004) return;
    this.drawnCharge = this.chargeRatio;

    // A compact halo of ticks above the caster: the accepted prefix lights it up
    // tick by tick, which reads instantly and never covers the artwork.
    const radius = this.chargeRingRadius;
    const lit = Math.round(this.chargeRatio * CHARGE_TICKS);
    this.charge.clear();
    this.charge
      .circle(0, 0, radius)
      .stroke({ width: 1.5, color: ELEMENT_DEEP[this.element], alpha: 0.6 });
    if (this.chargeRatio > 0) {
      const end = -Math.PI / 2 + Math.PI * 2 * this.chargeRatio;
      this.charge.arc(0, 0, radius, -Math.PI / 2, end).stroke({
        width: 7,
        color: ELEMENT_COLORS[this.element],
        alpha: 0.35,
        cap: 'round',
      });
      this.charge.arc(0, 0, radius, -Math.PI / 2, end).stroke({
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
      this.charge
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

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
