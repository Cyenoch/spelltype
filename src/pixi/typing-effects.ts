import { Application, Graphics, type Texture, type Ticker } from 'pixi.js';
import { ELEMENT_ORDER } from './assets';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../ui/elements';
import { motion } from '../ui/motion';
import { SparkPool } from './particles';
import { drawElementShard } from './effects/shapes';
import type { Element } from '../../shared/protocol';

/**
 * Power Mode sparks emitted by each committed character, including mistakes.
 * A small Canvas application overlays the native spell input. Four fixed pools
 * bound the particle count; the ticker sleeps once every trail has faded.
 * Bursts stay local to the glyph and never move the sentence or the battlefield.
 */
export interface TypingEffects {
  /** One local burst per committed character; errors use red instead of element tint. */
  emit(x: number, y: number, element: Element, error: boolean): void;
  /** Re-reads the host size; also self-observed. */
  resize(): void;
  destroy(): void;
}

/** Total pool, split evenly across the four element shapes. */
const CAPACITY_PER_ELEMENT = 96;
const SPARKS_PER_CHARACTER = 12;
const LIFE_MIN_MS = 360;
const LIFE_MAX_MS = 680;
const MAX_FRAME_MS = 48;

export async function createTypingEffects(host: HTMLElement): Promise<TypingEffects> {
  const app = new Application();
  await app.init({
    backgroundAlpha: 0,
    resizeTo: host,
    // Nothing animates until a committed character arrives.
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
  let burstSerial = 0;
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
    if (isReduced) {
      clearAll();
      app.stop();
    }
  });

  const pauseWhenHidden = () => {
    if (!document.hidden) return;
    clearAll();
    app.stop();
  };
  document.addEventListener('visibilitychange', pauseWhenHidden);

  return {
    emit(x: number, y: number, element: Element, error: boolean): void {
      if (destroyed || reduced || document.hidden) return;
      const pool = pools[element];
      const color = error ? 0xff536f : ELEMENT_COLORS[element];
      const core = error ? 0xffc4d0 : ELEMENT_CORE[element];
      // A soft leftward drift leaves unread text clear without looking like a jet.
      const phase = burstSerial++ * 2.399963;
      for (let index = 0; index < SPARKS_PER_CHARACTER; index += 1) {
        const angle = phase + (index / SPARKS_PER_CHARACTER) * Math.PI * 2;
        const speed = (0.09 + (index % 3) * 0.025) * (element === 'storm' ? 1.1 : 1);
        pool.spawn(
          x - 2,
          y,
          -0.016 - Math.abs(Math.cos(angle)) * speed * 0.4,
          Math.sin(angle) * speed * 0.75 - 0.02,
          LIFE_MIN_MS + (LIFE_MAX_MS - LIFE_MIN_MS) * ((index % 5) / 4),
          index % 3 === 0 ? 0.66 : 0.42,
          0.06,
          index % 3 === 0 ? core : color,
          0.95,
          element === 'arcane' ? 0.012 : 0.004,
          element === 'fire' || error ? 0.00013 : 0.000045,
          0.0014,
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
      document.removeEventListener('visibilitychange', pauseWhenHidden);
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
