import { Container, Texture } from 'pixi.js';
import { ELEMENT_ORDER } from '../assets';
import type { Element } from '../../../shared/protocol';
import { FighterBar } from './bar';
import { FighterBody } from './body';
import { FighterCharge } from './charge';

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
  /** This fighter's element rune, pre-rendered; the charge orbit reuses it. */
  rune: Texture;
}

/**
 * One full-body combatant: generated character art, an element aura, a ground
 * pool of its own element and an interpolated health bar, assembled from three
 * pieces — the posed body, the health bar and the torso charge orbit.
 *
 * Two groups matter. The body group (aura, art, ground) takes the poses — flinch,
 * tip-over, victory — while the bar and the charge runes never rotate: a read
 * that tips with its owner is unreadable exactly when it matters most.
 */
export class Fighter {
  readonly view = new Container();
  readonly slot: number;
  readonly element: Element;

  private readonly body: FighterBody;
  private readonly bar: FighterBar;
  private readonly charge: FighterCharge;

  private active = true;
  private eliminated = false;
  private koPending = false;

  constructor(
    slot: number,
    textures: FighterTextures,
    /** Tint of the health frame's end gems. */
    flashTint: number,
  ) {
    this.slot = slot;
    this.element = ELEMENT_ORDER[slot % ELEMENT_ORDER.length];
    this.body = new FighterBody(textures, this.element, slot);
    this.bar = new FighterBar(this.element, flashTint);
    this.charge = new FighterCharge(this.element, textures.rune, textures.glow);
    this.view.addChild(this.body.view, this.bar.view, this.charge.view);
  }

  /** True once this fighter has collapsed and is out of the match. */
  get isDown(): boolean {
    return this.eliminated;
  }

  get eliminationPending(): boolean {
    return this.koPending;
  }

  /** Hides a seat that has no occupant this match. */
  setActive(active: boolean): void {
    this.active = active;
    this.view.visible = active;
  }

  layout(layout: FighterLayout): FighterBox {
    const { x, feetY, bodyHeight, maxWidth, barOffsetY, baselineSpace } = layout;
    this.view.position.set(x, feetY);
    const box = this.body.layout(bodyHeight, maxWidth, baselineSpace);
    this.bar.layout(maxWidth, barOffsetY);
    this.charge.layout(box);
    this.paint();
    return box;
  }

  /** Applies authoritative state. `instant` skips the catch-up animation. */
  applyState(state: FighterState, instant: boolean, deferElimination = false): void {
    const hp = Math.min(1, Math.max(0, state.hpRatio));
    const hit = this.bar.applyHealth(hp, instant);
    this.body.applyRoomState(state.connected, 1 - hp, hit);
    // Every standing caster shows their charge now, not just the local viewer:
    // the runes are each fighter's own element, so no spell element is needed.
    this.charge.view.visible = !state.eliminated;
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
      // Back on their feet (revive, next match): the orbit must not show the
      // previous life's charge until fresh progress arrives.
      this.charge.reset();
      this.body.stand();
      return;
    }
    this.charge.reset();
    this.charge.view.visible = false;
    this.body.collapse(instant);
  }

  hit(strength: number, direction: number): void {
    if (this.eliminated) return;
    this.body.hit(strength, direction);
  }

  /** Played when this fighter lands a blow of its own. */
  flourish(): void {
    this.body.flourish();
  }

  setVictory(active: boolean): void {
    this.body.setVictory(active);
  }

  setCharge(ratio: number): void {
    this.charge.accept(ratio);
  }

  /** Live `prefers-reduced-motion` change: orbits freeze, accumulation stays. */
  setMotion(reduced: boolean): void {
    this.charge.setMotion(reduced);
  }

  update(deltaMS: number, pulse: number): void {
    this.bar.catchUp(deltaMS);
    this.body.update(deltaMS, pulse, this.eliminated);
    this.charge.update(deltaMS);
    this.paint();
  }

  private paint(): void {
    this.bar.paint();
    if (!this.eliminated) this.charge.paint();
  }

  destroy(): void {
    this.view.destroy({ children: true });
  }
}
