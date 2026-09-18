import { Container, type Texture } from 'pixi.js';
import { ELEMENT_ORDER } from '../assets';
import { ELEMENT_COLORS } from '../../ui/elements';
import type { Element } from '../../../shared/protocol';
import type { SparkPool } from '../particles';
import { Bolts, type BoltLanded } from './bolt';
import { Impacts } from './impact';
import { Transients } from './transients';
import {
  createJitter,
  emitEliminationBurst,
  emitTextMotes,
  emitTypingSpark,
  emitVictoryEmbers,
} from './particles';
import type { FxTextures } from './shapes';

/**
 * Bolts, impacts, shockwaves, typing sparks and damage floats.
 *
 * Every visual lives in a preallocated slot, so a match with hundreds of hits
 * never allocates during play and the layer can never grow past its bound. The
 * layer is pure presentation: it never decides damage, only shows what the
 * authoritative `CombatEvent` already said.
 */
export class FxLayer {
  readonly ground = new Container();
  readonly air = new Container();

  private readonly textures: FxTextures;
  private readonly pools: Record<Element, SparkPool>;
  private readonly bolts: Bolts;
  private readonly impacts: Impacts;
  private readonly transients: Transients;
  /** Shared with the effect families, so every randomised path stays deterministic. */
  private readonly jitter: () => number;

  constructor(textures: FxTextures, pools: Record<Element, SparkPool>, safeFlash: boolean) {
    this.textures = textures;
    this.pools = pools;
    const jitter = createJitter();
    this.jitter = jitter;
    this.bolts = new Bolts(textures, pools, jitter);
    this.impacts = new Impacts(textures, pools, jitter, safeFlash);
    this.transients = new Transients(textures);

    this.ground.addChild(this.transients.waves);
    this.air.addChild(this.bolts.view, this.impacts.view);
    // The element pools live above the fighters with the rest of the air layer,
    // and their containers are added here so a spawn is actually on screen.
    for (const element of ELEMENT_ORDER) this.air.addChild(pools[element].view);
    this.air.addChild(this.transients.floats);
  }

  /** Set once by the stage; fired when a bolt reaches its target. */
  set onLanded(handler: ((bolt: BoltLanded) => void) | null) {
    this.bolts.onLanded = handler;
  }

  get onLanded(): ((bolt: BoltLanded) => void) | null {
    return this.bolts.onLanded;
  }

  /** Starts a projectile flight. Purely visual; the DOM/rules are unaffected. */
  launch(
    seq: number,
    attackerId: string,
    targetId: string,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    element: Element,
    damage: number,
    eliminated: boolean,
    spellIndex: number,
  ): void {
    this.bolts.launch(
      seq,
      attackerId,
      targetId,
      fromX,
      fromY,
      toX,
      toY,
      element,
      damage,
      eliminated,
      spellIndex,
    );
  }

  /**
   * One hit's visible aftermath: shockwave on the ground, element ring, flash,
   * element shapes, shards and a floating damage number. `floatCeil` bounds the
   * number's ascent (canvas-local y from the seating's reserved top band).
   */
  impact(
    x: number,
    y: number,
    floatY: number,
    floatCeil: number,
    element: Element,
    strength: number,
    damage: number,
    artTexture: Texture | null,
    artBaseScale: number,
  ): void {
    this.impacts.burst(x, y, element, strength, artTexture, artBaseScale);
    this.transients.wave(x, y + 4, ELEMENT_COLORS[element], strength);
    this.transients.damageFloat(x, floatY, floatCeil, element, damage, strength);
  }

  /** Expanding ground ring, used by hits and eliminations. */
  groundWave(x: number, y: number, tint: number, strength: number): void {
    this.transients.wave(x, y, tint, strength);
  }

  /** The eliminated fighter's collapse: big ring, upward column of sparks, shards. */
  elimination(x: number, y: number, element: Element): void {
    this.transients.wave(x, y, ELEMENT_COLORS[element], 1.6);
    this.impacts.eliminate(x, y, element);
    emitEliminationBurst(this.pools[element], x, y, element);
  }

  /**
   * Rank-1 flourish at the end of a match: a golden seal on the floor, a rune
   * crown rising over the winner's head and a ring of embers. Everything is a
   * crisp stroked shape, because soft additive light disappears against the
   * bright arena sky.
   */
  victoryPillar(x: number, crownY: number, groundY: number, tint: number): void {
    this.impacts.hold(
      x,
      groundY,
      this.textures.rune.arcane,
      tint,
      0.0004,
      0.26,
      3.2,
      0.85,
      0xffe9b0,
      2.4,
      2600,
    );
    this.impacts.hold(
      x,
      crownY,
      this.textures.rune.fire,
      tint,
      -0.0012,
      1,
      1.5,
      0.9,
      0xfff2cf,
      1.6,
      2600,
    );
    emitVictoryEmbers(this.pools.arcane, x, groundY);
  }

  textMotes(x: number, element: Element, count: number): void {
    emitTextMotes(this.pools[element], x, element, count, this.jitter);
  }

  typingSpark(x: number, y: number, element: Element, amount: number): void {
    emitTypingSpark(this.pools[element], x, y, element, amount);
  }

  /** Advances every live effect. Called once per frame by the stage. */
  update(deltaMS: number): void {
    this.bolts.update(deltaMS);
    this.impacts.update(deltaMS);
    this.transients.update(deltaMS);
    for (const element of ELEMENT_ORDER) this.pools[element].update(deltaMS);
  }

  /** True while a projectile is still flying towards this fighter. */
  incomingFor(targetId: string): boolean {
    return this.bolts.incomingFor(targetId);
  }

  /** True while any projectile is in flight, used by the reduced-motion settle. */
  get airborne(): boolean {
    return this.bolts.airborne;
  }

  /**
   * Live `prefers-reduced-motion` change: from the next spawn on, impact flashes
   * are capped the same way they are for a match started in reduced motion. The
   * caller clears in-flight transients itself; nothing here mid-flight changes.
   */
  setReducedMotion(reduced: boolean): void {
    this.impacts.setReducedMotion(reduced);
  }

  clear(): void {
    this.bolts.clear();
    this.impacts.clear();
    this.transients.clear();
  }

  destroy(): void {
    this.onLanded = null;
    this.ground.destroy({ children: true });
    this.air.destroy({ children: true });
  }
}
