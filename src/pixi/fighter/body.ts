import { Container, Sprite } from 'pixi.js';
import { ELEMENT_COLORS, ELEMENT_CORE, ELEMENT_DEEP } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';
import type { FighterBox, FighterTextures } from './fighter';

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
 * Everything that takes a pose: the element aura, the ground pool, the art, its
 * rim glow and the veil, in one group that flinches, tips over and bobs as a
 * unit. The veil is the body's flat silhouette — grey shroud while down, white
 * wash during a hit — and stays out of the render build whenever it has neither.
 */
export class FighterBody {
  readonly view = new Container();

  private readonly plate: Sprite;
  private readonly shadow: Sprite;
  private readonly ground: Sprite;
  private readonly aura: Sprite;
  private readonly rim: Sprite;
  private readonly art: Sprite;
  private readonly veil: Sprite;

  /** Which way this seat tips over: the collapse leans away from the lane next door. */
  private readonly koDirection: number;
  private rimBaseHeight = 1;
  private rimBaseWidth = 1;
  private koClock = 0;
  private hitFlash = 0;
  private flinch = 0;
  private flinchDirection = 1;
  private connected = true;
  private danger = 0;
  private victory = false;

  constructor(
    textures: FighterTextures,
    private readonly element: Element,
    slot: number,
  ) {
    this.koDirection = slot % 2 === 0 ? 1 : -1;
    const color = ELEMENT_COLORS[element];

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
    this.ground.tint = ELEMENT_DEEP[element];
    this.ground.alpha = 0.5;

    this.art = new Sprite(textures.body);
    this.art.anchor.set(0.5, 1);

    this.rim = new Sprite(textures.body);
    this.rim.anchor.set(0.5);
    this.rim.blendMode = 'add';
    this.rim.tint = ELEMENT_CORE[element];
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

    this.view.addChild(
      this.plate,
      this.shadow,
      this.ground,
      this.aura,
      this.rim,
      this.art,
      this.veil,
    );
  }

  /** Fits the whole standing body into the seat box and reports what it drew. */
  layout(bodyHeight: number, maxWidth: number, baselineSpace: number): FighterBox {
    const texture = this.art.texture;
    const aspect = texture.width > 0 ? texture.width / texture.height : 0.5;
    // A narrow column can fit the art by width rather than by height; the caller
    // needs the box that was really drawn, or every anchor it derives (chest,
    // head, impact, damage float) drifts off the character.
    const drawnHeight = Math.min(bodyHeight, maxWidth / Math.max(0.001, aspect));
    const drawnWidth = drawnHeight * aspect;

    this.art.height = drawnHeight;
    this.art.width = drawnWidth;
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

    return { height: drawnHeight, width: drawnWidth };
  }

  /** Puts the body back on its feet, ready for the next match. */
  stand(): void {
    this.koClock = 0;
    this.view.rotation = 0;
    this.view.y = 0;
    // The collapse also shrinks the group; without this a fighter that comes
    // back (next match, rejoin) stays crumpled at the KO scale for good.
    this.view.scale.set(1);
    this.art.tint = 0xffffff;
    this.art.alpha = 1;
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
  }

  /** Starts the collapse; `instant` jumps it straight to the final pose. */
  collapse(instant: boolean): void {
    this.victory = false;
    this.veil.tint = 0xa6a3b8;
    this.veil.renderable = true;
    this.koClock = instant ? KO_MS : 0;
    this.applyKoPose();
  }

  /**
   * Visible reaction to a hit: a shove away from wherever the blow came from,
   * plus a white wash over the body (a multiply tint can only darken art, so the
   * veil sprite is what makes a hit read as brightness).
   */
  hit(strength: number, direction: number): void {
    const scaled = 0.7 + Math.min(1, Math.max(0, strength)) * 0.5;
    this.flinch = FLINCH_MS * scaled;
    this.flinchDirection = direction >= 0 ? 1 : -1;
    this.hitFlash = 1;
    this.veil.tint = 0xffffff;
    this.veil.renderable = true;
  }

  flourish(): void {
    this.hitFlash = Math.max(this.hitFlash, 0.4);
  }

  setVictory(active: boolean): void {
    this.victory = active;
    if (!active) this.aura.tint = ELEMENT_COLORS[this.element];
  }

  /** Room-derived inputs for the standing pose: connection, low-health danger, fresh hit. */
  applyRoomState(connected: boolean, danger: number, hit: boolean): void {
    this.connected = connected;
    this.danger = danger;
    if (hit) this.hitFlash = 1;
  }

  /**
   * One frame of posing, in the order the flinch, the hit wash and — depending on
   * whether the body is down — the collapse or the standing breath run.
   */
  update(deltaMS: number, pulse: number, down: boolean): void {
    let offsetX = 0;
    let wobble = 0;
    if (this.flinch > 0) {
      this.flinch = Math.max(0, this.flinch - deltaMS);
      const t = this.flinch / FLINCH_MS;
      const shove = t * Math.sin(t * Math.PI);
      offsetX += this.flinchDirection * 18 * shove;
      wobble = this.flinchDirection * 0.05 * shove;
    }
    if (this.view.x !== offsetX) this.view.x = offsetX;
    if (!down) this.view.rotation = wobble;

    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - deltaMS / 190);
      // The veil doubles as the hit wash while the fighter is standing; once the
      // fighter is down the collapse owns both its colour and its alpha, or the
      // shroud would stay white whenever the killing blow also landed a hit.
      if (!down) {
        this.veil.renderable = true;
        this.veil.tint = 0xffffff;
        this.veil.alpha = 0.42 * this.hitFlash;
      }
    } else if (!down && this.veil.alpha !== 0) {
      // The wash has run out: park the veil outside the build again.
      this.veil.alpha = 0;
      this.veil.renderable = false;
    }

    if (down) {
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
        this.view.y = -6 - breath * 4;
      } else if (this.view.y !== 0) {
        this.view.y = 0;
      }
    }
  }

  private applyKoPose(): void {
    const progress = Math.min(1, this.koClock / KO_MS);
    const eased = 1 - (1 - progress) * (1 - progress);
    const crumple = 1 - 0.12 * eased;
    this.view.rotation = this.koDirection * KO_TILT * eased;
    this.view.scale.set(crumple);
    // Rotating about the feet swings the body's width below the feet line, which
    // would sweep it through the health bar; the lift puts it back on the floor.
    const lift = (this.rimBaseWidth * 0.5 * Math.sin(KO_TILT) * crumple + 10) * eased;
    this.view.y = -lift;
    this.art.tint = KO_TINT;
    this.art.alpha = 1;
    this.veil.alpha = 0.72 * eased;
    this.rim.alpha = 0;
    this.plate.alpha = 0.3 * (1 - eased);
    this.aura.alpha = 0;
    this.shadow.alpha = 0.62 - eased * 0.25;
  }
}
