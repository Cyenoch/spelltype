import { Container, Graphics, Sprite, type Texture } from 'pixi.js';
import { ELEMENT_COLORS } from '../ui/elements';
import { ELEMENT_ORDER } from './assets';
import type { SparkPool } from './particles';

export interface ArenaTextures {
  /** Arena backdrops; the first entry that loaded is used. */
  skies: (Texture | null)[];
  sigil: Texture | null;
  glow: Texture;
  ring: Texture;
}

const SIGIL_COUNT = 5;
const MOTE_FLOOR = 220;
const MAX_PARALLAX = 16;

/**
 * The battlefield itself: a painterly arena backdrop, haze bands, drifting
 * sigils, a rune floor, foreground motes and the low-health / final-seconds
 * atmosphere.
 *
 * Depth comes from parallax rather than from stacking two different arenas on
 * top of each other, so the scene stays readable: the sky drifts least, the
 * haze a little more, the dust in front of the fighters most. Everything is
 * drawn at layout time and only transformed per frame, so the arena costs a
 * handful of draw calls and no vector rebuilds.
 */
export class Arena {
  readonly back = new Container();
  readonly floor = new Container();
  readonly fore = new Container();

  private readonly textures: ArenaTextures;
  private readonly motes: SparkPool;
  private readonly sky = new Sprite();
  private readonly skyFallback = new Graphics();
  private readonly haze = new Graphics();
  private readonly floorPlate = new Graphics();
  private readonly floorRune: Sprite;
  private readonly rim = new Graphics();
  private readonly sigils: Sprite[] = [];
  private readonly sigilPhase: number[] = [];
  private readonly sigilBaseY: number[] = [];
  private skyTexture: Texture | null = null;
  private width = 1;
  private height = 1;
  private danger = 0;
  private finalSeconds = false;
  private focusX = 0;
  private focusY = 0;
  private drift = 0;
  private moteClock = 0;
  private readonly reduced: () => boolean;

  constructor(textures: ArenaTextures, motes: SparkPool, reduced: () => boolean) {
    this.textures = textures;
    this.motes = motes;
    this.reduced = reduced;

    this.sky.anchor.set(0.5);
    // The rim is an atmosphere readout, dark with no danger and no final seconds.
    // Its own steady state is `0`, so it must not sit at the default alpha of 1
    // and paint the vignette bars before anything has called update().
    this.rim.alpha = 0;
    this.floorRune = new Sprite(textures.ring);
    this.floorRune.anchor.set(0.5);
    this.floorRune.blendMode = 'add';
    this.floorRune.tint = ELEMENT_COLORS[ELEMENT_ORDER[0]];
    this.floorRune.alpha = 0.22;

    this.back.addChild(this.skyFallback, this.sky, this.haze);
    for (let index = 0; index < SIGIL_COUNT; index += 1) {
      const sigil = new Sprite(textures.sigil ?? textures.ring);
      sigil.anchor.set(0.5);
      sigil.blendMode = 'add';
      sigil.tint = ELEMENT_COLORS[ELEMENT_ORDER[index % ELEMENT_ORDER.length]];
      sigil.alpha = 0.16;
      this.sigils.push(sigil);
      this.sigilPhase.push((index * Math.PI * 2) / SIGIL_COUNT);
      this.back.addChild(sigil);
    }
    this.floor.addChild(this.floorPlate, this.floorRune);
    this.fore.addChild(motes.view, this.rim);
  }

  /** Selects one of the preloaded arena backdrops for a fresh match. */
  setArena(index: number): void {
    const loaded = this.textures.skies.filter((texture): texture is Texture => texture !== null);
    const next =
      loaded.length > 0 ? loaded[((index % loaded.length) + loaded.length) % loaded.length] : null;
    if (next === this.skyTexture) return;
    this.skyTexture = next;
    if (next) {
      this.sky.texture = next;
      this.sky.visible = true;
      this.skyFallback.visible = false;
    } else {
      this.sky.visible = false;
      this.skyFallback.visible = true;
    }
    this.layout(this.width, this.height);
  }

  layout(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const { width: w, height: h } = this;

    const horizon = h * 0.86;
    if (this.skyTexture) {
      const texture = this.skyTexture;
      const cover = Math.max(w / texture.width, h / texture.height) * 1.06;
      this.sky.width = texture.width * cover;
      this.sky.height = texture.height * cover;
      this.sky.position.set(w / 2, h * 0.5);
    } else {
      this.skyFallback
        .clear()
        .rect(0, 0, w, h)
        .fill({ color: 0x0b0817 })
        .rect(0, h * 0.35, w, h * 0.35)
        .fill({ color: 0x1a1233, alpha: 0.85 })
        .rect(0, horizon - h * 0.18, w, h * 0.2)
        .fill({ color: 0x2a1c46, alpha: 0.7 });
    }

    this.haze
      .clear()
      .rect(0, horizon - h * 0.26, w, h * 0.1)
      .fill({ color: 0x2f2154, alpha: 0.2 })
      .rect(0, horizon - h * 0.16, w, h * 0.12)
      .fill({ color: 0x3b2a63, alpha: 0.18 })
      .rect(0, horizon - h * 0.06, w, h * 0.14)
      .fill({ color: 0x120c24, alpha: 0.35 });

    this.floorPlate
      .clear()
      .ellipse(w / 2, horizon + h * 0.06, w * 0.56, h * 0.1)
      .fill({ color: 0x090614, alpha: 0.62 })
      .ellipse(w / 2, horizon + h * 0.05, w * 0.46, h * 0.07)
      .fill({ color: 0x171029, alpha: 0.5 });

    this.floorRune.width = w * 0.82;
    this.floorRune.height = h * 0.14;
    this.floorRune.position.set(w / 2, horizon + h * 0.05);

    const inset = Math.max(24, Math.min(w, h) * 0.06);
    this.rim
      .clear()
      .rect(0, 0, w, inset * 0.5)
      .fill({ color: 0x000000, alpha: 0.28 })
      .rect(0, h - inset, w, inset)
      .fill({ color: 0x000000, alpha: 0.28 })
      .rect(0, 0, inset * 0.6, h)
      .fill({ color: 0x000000, alpha: 0.24 })
      .rect(w - inset * 0.6, 0, inset * 0.6, h)
      .fill({ color: 0x000000, alpha: 0.24 });

    const sigilSize = Math.min(w, h) * 0.22;
    for (let index = 0; index < this.sigils.length; index += 1) {
      const sigil = this.sigils[index];
      sigil.width = sigilSize * (0.7 + (index % 3) * 0.25);
      sigil.height = sigil.width;
      const baseY = h * (0.34 + (index % 2) * 0.12);
      this.sigilBaseY[index] = baseY;
      sigil.position.set(w * (0.14 + index * 0.19), baseY);
    }
  }

  /** 0..1: how close the local player is to elimination. */
  setDanger(level: number): void {
    this.danger = Math.max(0, Math.min(1, level));
  }

  /** Turns the arena rim warm while the match clock runs out. */
  setFinalSeconds(active: boolean): void {
    this.finalSeconds = active;
  }

  /** Normalised pointer position, -1..1 on both axes. */
  setFocus(x: number, y: number): void {
    this.focusX = Math.max(-1, Math.min(1, x));
    this.focusY = Math.max(-1, Math.min(1, y));
  }

  update(deltaMS: number): void {
    const reduced = this.reduced();
    this.drift = reduced ? 0 : this.drift + deltaMS;

    const parallaxX = this.focusX * MAX_PARALLAX;
    const parallaxY = this.focusY * MAX_PARALLAX * 0.5;
    const idle = reduced ? 0 : Math.sin(this.drift / 5200) * 6;
    const idleY = reduced ? 0 : Math.cos(this.drift / 7100) * 4;

    this.back.x = -parallaxX * 0.4 + idle;
    this.back.y = -parallaxY * 0.4 + idleY;
    this.floor.x = -parallaxX * 0.15;
    this.floor.y = -parallaxY * 0.1;
    this.fore.x = -parallaxX * 1.15 + idle * 1.6;
    this.fore.y = -parallaxY * 1.1 + idleY * 1.6;

    const pulse = reduced ? 0.5 : (Math.sin(this.drift / 900) + 1) / 2;
    const dangerPulse = reduced ? 0.5 : (Math.sin(this.drift / 1500) + 1) / 2;

    for (let index = 0; index < this.sigils.length; index += 1) {
      const sigil = this.sigils[index];
      const phase =
        this.sigilPhase[index] + (reduced ? 0 : this.drift / 3000) * (0.6 + index * 0.12);
      sigil.rotation = phase * 0.5;
      sigil.alpha = 0.1 + pulse * 0.08 + this.danger * 0.06;
      sigil.y = (this.sigilBaseY[index] ?? sigil.y) + (reduced ? 0 : Math.sin(phase) * 6);
    }

    this.floorRune.alpha = 0.1 + pulse * 0.06 + (this.finalSeconds ? dangerPulse * 0.08 : 0);

    const rimAlpha = this.danger * 0.34 + (this.finalSeconds ? 0.1 + dangerPulse * 0.12 : 0);
    this.rim.alpha = Math.min(0.55, rimAlpha);
    this.rim.tint = this.finalSeconds && this.danger > 0.4 ? 0x6b3410 : 0x3c0a14;

    this.spawnMotes(deltaMS, reduced);
    this.motes.update(deltaMS);
  }

  /** Deterministic teardown: the three layers own every graphic the arena made. */
  destroy(): void {
    this.back.destroy({ children: true });
    this.floor.destroy({ children: true });
    this.fore.destroy({ children: true });
  }

  /** Ambient dust in front of the fighters; the only arena animation in reduced motion is off. */
  private spawnMotes(deltaMS: number, reduced: boolean): void {
    if (reduced) return;
    this.moteClock += deltaMS;
    while (this.moteClock >= 150) {
      this.moteClock -= 150;
      if (this.motes.live > this.motes.capacity * 0.8) break;
      const x = Math.random() * this.width;
      const y = this.height * (0.55 + Math.random() * 0.45);
      const rise = 0.012 + Math.random() * 0.02;
      this.motes.spawn(
        x,
        y,
        (Math.random() - 0.5) * 0.01,
        -rise,
        MOTE_FLOOR * (0.7 + Math.random() * 0.6),
        0.25 + Math.random() * 0.25,
        0.08,
        Math.random() < 0.3 ? 0xb9a6ff : 0xffffff,
        0.22,
        0.001,
        -0.000004,
        0.0004,
      );
    }
  }
}
