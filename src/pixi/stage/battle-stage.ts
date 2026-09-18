import { Container, type Ticker } from 'pixi.js';
import { ELEMENT_ORDER } from '../assets';
import { ELEMENT_CORE } from '../../ui/elements';
import { motion } from '../../ui/motion';
import { Arena } from '../arena';
import { Fighter } from '../fighter/fighter';
import { FxLayer } from '../effects/layer';
import { createFxTextures, destroyFxTextures, type FxTextures } from '../effects/shapes';
import { SparkPool } from '../particles';
import { createAimLayer } from './aim';
import { createChoreography } from './choreography';
import { createCombat } from './combat';
import { createGlyphLayer } from './glyphs';
import { createMatch } from './match';
import { createSeating } from './seating';
import { createStageApp } from './app';
import { createStageAssets } from './assets';
import type { Element, RoomSnapshot } from '../../../shared/protocol';

/**
 * The live battle arena.
 *
 * `update` is fed the authoritative snapshot and `typing` the confirmed local
 * prefix; neither of them decides anything about damage. Hits are drawn from
 * `CombatEvent`s, deduplicated per match by `(matchId, seq)`, so a reconnect
 * that re-delivers the room's event ring never replays an old attack.
 */
export interface BattleStage {
  update(snapshot: RoomSnapshot, selfId: string): void;
  typing(progress: number, element: Element): void;
  destroy(): void;
}

const SLOT_COUNT = 4;
/** Frame clamp: a backgrounded tab must not teleport every effect on return. */
const MAX_FRAME_MS = 48;

export async function createBattleStage(host: HTMLElement): Promise<BattleStage> {
  const stageApp = await createStageApp(host);
  const app = stageApp.app;
  const assets = createStageAssets();

  /**
   * Art bootstrap. The renderer goes down before the art does: a texture source
   * destroyed while the live application still has it bound to a shader is what
   * makes Pixi warn about a resource being destroyed while still bound.
   */
  const loadArt = async (): Promise<FxTextures> => {
    try {
      await assets.load();
      return createFxTextures(app);
    } catch (error) {
      stageApp.destroy();
      assets.dispose();
      throw error;
    }
  };
  const shapes = await loadArt();

  let destroyed = false;
  let reduced = motion.reduced || host.dataset.motion === 'reduced';
  let clock = 0;
  let frameCount = 0;

  const budget = stageApp.canvasRenderer ? 0.55 : reduced ? 0.5 : 1;
  const pools = {
    arcane: new SparkPool(shapes.shard.arcane, Math.round(96 * budget), 'add'),
    fire: new SparkPool(shapes.shard.fire, Math.round(96 * budget), 'add'),
    ice: new SparkPool(shapes.shard.ice, Math.round(96 * budget), 'add'),
    storm: new SparkPool(shapes.shard.storm, Math.round(96 * budget), 'add'),
  } satisfies Record<Element, SparkPool>;
  const motes = new SparkPool(shapes.glow, reduced ? 28 : Math.round(110 * budget), 'normal');

  const world = new Container();
  app.stage.addChild(world);

  const arena = new Arena({ sigil: assets.sigil, ring: shapes.ring }, motes, () => reduced);
  const fighterLayer = new Container();
  const fx = new FxLayer(shapes, pools, reduced);

  const fighters = Array.from({ length: SLOT_COUNT }, (_, slot) => {
    const texture = assets.characters[slot % assets.characters.length];
    const fighter = new Fighter(
      slot,
      {
        body: texture,
        silhouette: assets.silhouettes[slot % assets.characters.length],
        glow: shapes.glow,
        ring: shapes.ring,
        rune: shapes.rune[ELEMENT_ORDER[slot % ELEMENT_ORDER.length]],
      },
      ELEMENT_CORE[ELEMENT_ORDER[slot % ELEMENT_ORDER.length]],
    );
    fighter.setActive(false);
    fighter.setMotion(reduced);
    fighterLayer.addChild(fighter.view);
    return fighter;
  });

  const seating = createSeating(fighters);
  const glyphs = createGlyphLayer(fx.air, shapes, assets);
  const aim = createAimLayer(seating, shapes, assets);
  // The targeting tether sits behind the fighters so it never draws across a
  // character: it is read in the gap between them, the way a real sight line is.
  world.addChild(arena.back, arena.floor, fx.ground, aim.view, fighterLayer, fx.air, arena.fore);

  const advance = (deltaMS: number): void => {
    fx.update(deltaMS);
    for (const fighter of fighters) fighter.update(deltaMS, 0.5);
    glyphs.update(deltaMS);
  };

  /** Drops every live effect and particle: the arena is left showing nothing. */
  const clearEffects = (): void => {
    fx.clear();
    for (const pool of Object.values(pools)) pool.clear();
    motes.clear();
  };

  const choreography = createChoreography({
    world,
    screen: app.screen,
    fighters,
    seating,
    fx,
    frame: advance,
    paint: stageApp.paint,
  });

  const combat = createCombat({
    host,
    fighters,
    slotOf: (userId) => match.slotOf(userId),
    seating,
    fx,
    assets,
    beats: choreography,
    reduced: () => reduced,
  });

  const match = createMatch({
    host,
    fighters,
    seating,
    arena,
    aim,
    assets,
    combat,
    glyphs,
    fx,
    choreography,
    clearEffects,
    relayout: () => layout(),
    paint: stageApp.paint,
    clock: () => clock,
    reduced: () => reduced,
  });

  fx.onLanded = (bolt) => {
    if (destroyed) return;
    combat.resolve(bolt, clock);
  };

  const layout = (): void => {
    if (destroyed) return;
    const width = app.screen.width;
    const height = app.screen.height;
    stageApp.syncResolution();
    arena.layout(width, height);

    const present: number[] = [];
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      if (match.occupancy[slot] !== null) present.push(slot);
    }
    // The viewer reads themselves leftmost — the same order the DOM overhead
    // labels use (`visualSeatOrder` in battle-view). Column order is purely
    // visual: slots, targeting and events keep their authoritative identities,
    // and every anchor (chest, feet bar, tether, projectile) reads back through
    // `seating` by slot.
    const selfSlot = match.selfSlot;
    if (selfSlot >= 0) {
      present.sort((left, right) =>
        left === selfSlot ? -1 : right === selfSlot ? 1 : left - right,
      );
    }
    if (seating.layout(width, height, present)) match.relayoutAim();
    stageApp.paint();
  };

  const tick = (tickerInstance: Ticker): void => {
    if (destroyed) return;
    const delta = Math.min(MAX_FRAME_MS, tickerInstance.deltaMS);
    clock += delta;

    arena.update(delta);
    for (const fighter of fighters) fighter.update(delta, clock / 900);
    fx.update(delta);
    glyphs.update(delta);

    combat.spawn(delta, clock);
    combat.sweep(clock);

    aim.pulse(clock, match.selfProgress, match.phase === 'playing');
    aim.spin(delta);
    choreography.update(delta, match.phase, match.occupancy, match.chargeElement);
    // The TickerPlugin renders this same frame right after this callback, so a
    // ticker-driven frame is reported here and nowhere else.
    frameCount += 1;
    host.dataset.frames = String(frameCount);
  };

  app.ticker.add(tick);
  stageApp.watchResize(layout);
  host.appendChild(app.canvas);
  host.dataset.motion = reduced ? 'reduced' : 'full';
  host.dataset.renderer = stageApp.rendererName;
  host.dataset.stage = assets.ready ? 'ready' : 'degraded';
  host.dataset.frames = '0';
  host.dataset.paints = '0';
  layout();
  if (!reduced) app.start();

  const unsubscribeMotion = motion.subscribe((isReduced) => {
    choreography.stopSettle();
    if (isReduced) {
      app.stop();
      // Finish confirmed hits before changing modes; dropping in-flight bolts
      // would lose their impact and deferred elimination feedback.
      fx.update(2400);
    }
    reduced = isReduced;
    fx.setReducedMotion(isReduced);
    for (const fighter of fighters) fighter.setMotion(isReduced);
    host.dataset.motion = isReduced ? 'reduced' : 'full';
    if (isReduced) {
      combat.flush(clock);
      advance(2400);
      clearEffects();
      choreography.calm();
      arena.update(0);
      stageApp.paint();
    } else {
      app.start();
    }
  });

  const handlePointer = (event: PointerEvent): void => {
    if (reduced) return;
    const rect = host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    arena.setFocus(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      ((event.clientY - rect.top) / rect.height) * 2 - 1,
    );
  };
  window.addEventListener('pointermove', handlePointer, { passive: true });

  return {
    update(snapshot: RoomSnapshot, nextSelfId: string): void {
      if (destroyed) return;
      match.update(snapshot, nextSelfId);
    },

    typing(progress: number, element: Element): void {
      if (destroyed) return;
      match.typing(progress, element);
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      app.stop();
      choreography.stopSettle();
      unsubscribeMotion();
      stageApp.stopWatchingResize();
      window.removeEventListener('pointermove', handlePointer);
      app.ticker.remove(tick);
      fx.onLanded = null;
      fx.destroy();
      for (const pool of Object.values(pools)) pool.destroy();
      motes.destroy();
      arena.destroy();
      // Owned textures go only after the renderer: a source destroyed while the
      // live application still has it bound to a shader is what Pixi warns about.
      stageApp.destroy();
      destroyFxTextures(shapes);
      assets.dispose();
      for (const key of [
        'motion',
        'renderer',
        'stage',
        'phase',
        'seats',
        'hits',
        'hitSeq',
        'typingSeq',
        'typingFx',
        'frames',
        'paints',
      ]) {
        delete host.dataset[key];
      }
    },
  };
}
