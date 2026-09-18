import { Application, Graphics, type Texture, type Ticker } from 'pixi.js';
import { ELEMENT_ORDER } from './assets';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../ui/elements';
import { motion } from '../ui/motion';
import { SparkPool } from './particles';
import { drawElementShard } from './effects/shapes';
import type { Element } from '../../shared/protocol';

/**
 * Particles that come off the confirmed spell text itself.
 *
 * This is a second, deliberately tiny PIXI application overlaid on the DOM spell
 * run: it is bounded (96 pooled particles), it prefers the Canvas renderer so it
 * does not open a third GPU context next to the arena and the backdrop, and its
 * ticker only runs while something is alive. Nothing is drawn above the text
 * baseline, so no glyph is ever obscured and the DOM text stays the only source
 * of truth — this layer is decoration and nothing else.
 */
export interface TypingEffects {
  /** Emits off a confirmed glyph, in CSS pixels local to the host. */
  emit(x: number, y: number, element: Element, count: number): void;
  /** Re-reads the host size; also self-observed. */
  resize(): void;
  destroy(): void;
}

/** Total pool, split evenly across the four element shapes. */
const CAPACITY_PER_ELEMENT = 24;
/** Hard cap per emit call, whatever the caller asks for. */
const MAX_PER_EMIT = 6;
const LIFE_MIN_MS = 450;
const LIFE_MAX_MS = 650;
/** Downwards is positive y: sparks leave the baseline without crossing a glyph. */
const SPREAD_SPEED = 0.055;
const FALL_MIN = 0.018;
const FALL_MAX = 0.055;
const MAX_FRAME_MS = 48;

export async function createTypingEffects(host: HTMLElement): Promise<TypingEffects> {
  const app = new Application();
  await app.init({
    backgroundAlpha: 0,
    resizeTo: host,
    // Nothing animates until the first confirmed character arrives.
    autoStart: false,
    antialias: false,
    preference: ['canvas'],
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    // Purely decorative, and every interaction belongs to the DOM text under it
    // (the host is `pointer-events: none`). The event system binds capture-phase
    // pointer listeners on the document as soon as an application initialises, so
    // with nothing here to hit, all four feature sets are switched off and the
    // stage is left non-interactive: no event for this canvas is ever normalised,
    // mapped or hit-tested.
    eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
  });
  app.stage.eventMode = 'none';

  let destroyed = false;
  let reduced = motion.reduced;
  const owned: Texture[] = [];
  const shapes = {} as Record<Element, Texture>;

  try {
    for (const element of ELEMENT_ORDER) {
      const graphics = new Graphics();
      drawElementShard(graphics, element);
      const texture = app.renderer.generateTexture({
        target: graphics,
        resolution: 2,
        antialias: true,
      });
      graphics.destroy();
      shapes[element] = texture;
      owned.push(texture);
    }
  } catch (error) {
    app.destroy({ removeView: true }, { children: true });
    for (const texture of owned) {
      if (!texture.destroyed) texture.destroy(true);
    }
    throw error;
  }

  const pools = {
    arcane: new SparkPool(shapes.arcane, CAPACITY_PER_ELEMENT, 'add'),
    fire: new SparkPool(shapes.fire, CAPACITY_PER_ELEMENT, 'add'),
    ice: new SparkPool(shapes.ice, CAPACITY_PER_ELEMENT, 'add'),
    storm: new SparkPool(shapes.storm, CAPACITY_PER_ELEMENT, 'add'),
  } satisfies Record<Element, SparkPool>;
  for (const element of ELEMENT_ORDER) app.stage.addChild(pools[element].view);

  const clearAll = (): void => {
    let live = 0;
    for (const element of ELEMENT_ORDER) {
      pools[element].clear();
      live += pools[element].live;
    }
    if (live === 0) app.render();
  };

  const tick = (tickerInstance: Ticker): void => {
    if (destroyed) return;
    const delta = Math.min(MAX_FRAME_MS, tickerInstance.deltaMS);
    let live = 0;
    for (const element of ELEMENT_ORDER) {
      pools[element].update(delta);
      live += pools[element].live;
    }
    if (live > 0) return;
    // One final frame clears the canvas, then the overlay costs nothing at all.
    app.render();
    app.stop();
  };
  app.ticker.add(tick);

  host.appendChild(app.canvas);

  const resizeObserver = new ResizeObserver(() => {
    if (!destroyed) app.queueResize();
  });
  resizeObserver.observe(host);

  const unsubscribeMotion = motion.subscribe((isReduced) => {
    reduced = isReduced;
    if (isReduced) clearAll();
  });

  return {
    emit(x: number, y: number, element: Element, count: number): void {
      if (destroyed || reduced) return;
      const total = Math.max(1, Math.min(MAX_PER_EMIT, Math.trunc(count)));
      const pool = pools[element] ?? pools.arcane;
      const color = ELEMENT_COLORS[element];
      const core = ELEMENT_CORE[element];
      for (let index = 0; index < total; index += 1) {
        // Fan outwards and downwards from just under the baseline: the sparks are
        // always below the glyphs, so the text stays fully legible.
        const fan = (index - (total - 1) / 2) * 0.42;
        const speed = SPREAD_SPEED * (0.6 + (index % 3) * 0.25);
        const fall = FALL_MIN + (FALL_MAX - FALL_MIN) * ((index % 4) / 3);
        // A third of them float a hair upwards, never more than a pixel or two.
        const lift = index % 3 === 0 ? -0.006 : 0;
        pool.spawn(
          x + fan * 6,
          y + 1,
          Math.sin(fan) * speed,
          fall + lift,
          LIFE_MIN_MS + (LIFE_MAX_MS - LIFE_MIN_MS) * ((index % 5) / 4),
          0.5,
          0.16,
          index % 2 === 0 ? core : color,
          0.92,
          0.004,
          0.00004,
          0.0016,
        );
      }
      if (!app.ticker.started) app.start();
    },

    resize(): void {
      if (destroyed) return;
      app.resize();
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      resizeObserver.disconnect();
      unsubscribeMotion();
      app.ticker.remove(tick);
      for (const element of ELEMENT_ORDER) pools[element].destroy();
      // Renderer first: it owns one bind group per texture it has drawn and only
      // lets them go in its own teardown, so destroying a shard source while the
      // application is still alive would report it as destroyed while bound.
      app.destroy({ removeView: true }, { children: true });
      for (const texture of owned) {
        if (!texture.destroyed) texture.destroy(true);
      }
    },
  };
}
