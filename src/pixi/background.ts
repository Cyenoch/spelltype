import { Application, Container, Sprite, type Texture, type Ticker } from 'pixi.js';
import { ASSETS, arenaFor } from '../assets';
import { motion } from '../motion';
import { SparkPool } from './particles';
import { acquireTextures, releaseTextures } from './textures';

export interface BackgroundScene {
  destroy(): void;
}

/** Ambient motes kept alive at once; the reduced-motion scene keeps a sparse field. */
const MOTE_TARGET = 64;
const MOTE_TARGET_REDUCED = 16;
/** How long one arena backdrop is shown before the next one fades in. */
const PLATE_INTERVAL_MS = 26_000;
const PLATE_FADE_MS = 2_400;
const PARALLAX_SHIFT = 22;

/**
 * Page-wide academy backdrop: the generated arena art crossfading behind the
 * interface, a drifting mote field, a soft element glow and gentle pointer
 * parallax. It degrades to a single static frame under reduced-motion and
 * releases every texture it acquired when it is torn down.
 */
export async function createBackgroundScene(host: HTMLElement): Promise<BackgroundScene> {
  const app = new Application();
  await app.init({
    background: '#07060f',
    resizeTo: host,
    antialias: false,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    autoStart: false,
    eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    preference: ['webgl', 'webgpu', 'canvas'],
    powerPreference: 'low-power',
  });
  app.stage.eventMode = 'none';

  const arenaUrls = [0, 1, 2, 3].map((index) => arenaFor(index));
  const acquired = [...arenaUrls, ASSETS.background, ASSETS.spark];
  let records: (Texture | null)[] = [];
  try {
    records = await acquireTextures(acquired);
  } catch (error) {
    releaseTextures(acquired);
    app.destroy({ removeView: true }, { children: true });
    throw error;
  }

  const arenas = records.slice(0, arenaUrls.length).filter((texture): texture is Texture => texture !== null);
  const fallbackTexture = records[arenaUrls.length] ?? null;
  const sparkTexture = records[arenaUrls.length + 1] ?? null;
  const plates = arenas.length > 0 ? arenas : fallbackTexture ? [fallbackTexture] : [];
  if (plates.length === 0 || !sparkTexture) {
    // Nothing to draw with: report the failure instead of running an empty loop.
    releaseTextures(acquired);
    app.destroy({ removeView: true }, { children: true });
    throw new Error('背景素材加载失败');
  }

  let disposed = false;
  let reduced = motion.reduced;
  let plateIndex = 0;
  let plateClock = 0;
  let fadeProgress = 1;
  let elapsed = 0;

  const world = new Container();
  app.stage.addChild(world);

  const base = new Sprite(plates[0]);
  base.anchor.set(0.5);
  const incoming = new Sprite(plates[0]);
  incoming.anchor.set(0.5);
  incoming.visible = plates.length > 1;
  // Starts hidden: it fades in over the base, so it must be drawn after it.
  incoming.alpha = 0;

  const glow = new Sprite(sparkTexture);
  glow.anchor.set(0.5);
  glow.tint = 0x8f7dff;
  glow.alpha = 0.2;

  const motes = new SparkPool(sparkTexture, MOTE_TARGET, 'add');
  const moteLayer = motes.view;
  world.addChild(base, incoming, glow, moteLayer);

  const coverScale = (texture: Texture, width: number, height: number): number => {
    const source = texture.source;
    const textureWidth = source.pixelWidth || source.width || width;
    const textureHeight = source.pixelHeight || source.height || height;
    return Math.max(width / textureWidth, height / textureHeight) * 1.06;
  };

  const layout = (): void => {
    if (disposed) return;
    const { width, height } = app.screen;
    if (width === 0 || height === 0) return;

    const scale = coverScale(base.texture, width, height);
    base.width = base.texture.width * scale;
    base.height = base.texture.height * scale;
    const incomingScale = coverScale(incoming.texture, width, height);
    incoming.width = incoming.texture.width * incomingScale;
    incoming.height = incoming.texture.height * incomingScale;
    base.position.set(width * 0.5, height * 0.5 - height * 0.02);
    incoming.position.copyFrom(base.position);

    glow.position.set(width * 0.5, height * 0.34);
    glow.width = width * 0.9;
    glow.height = height * 0.9;

    if (reduced) app.render();
  };

  const spawnMote = (width: number, height: number): void => {
    const tint = Math.random() < 0.34 ? 0xffd9a2 : 0xb9aaff;
    motes.spawn(
      Math.random() * width,
      height * (0.1 + Math.random() * 0.9),
      (Math.random() - 0.5) * 0.012,
      -(6 + Math.random() * 20) / 1000,
      5_000 + Math.random() * 5_000,
      0.08 + Math.random() * 0.16,
      0.05,
      tint,
      0.12 + Math.random() * 0.35,
      0.0008,
      0,
      0.00002,
    );
  };

  const pointer = { x: 0, y: 0 };
  const drift = { x: 0, y: 0 };

  const handlePointer = (event: PointerEvent): void => {
    const { width, height } = app.screen;
    pointer.x = width === 0 ? 0 : (event.clientX / width - 0.5) * 2;
    pointer.y = height === 0 ? 0 : (event.clientY / height - 0.5) * 2;
  };

  const tick = (tickerInstance: Ticker): void => {
    const deltaMS = Math.min(48, tickerInstance.deltaMS);
    if (reduced) return;
    elapsed += deltaMS;

    const follow = 1 - Math.pow(0.96, deltaMS / (1000 / 60));
    drift.x += (pointer.x - drift.x) * follow;
    drift.y += (pointer.y - drift.y) * follow;
    const { width, height } = app.screen;
    const shiftX = -drift.x * PARALLAX_SHIFT;
    const shiftY = -drift.y * PARALLAX_SHIFT;

    base.position.set(width * 0.5 + shiftX, height * 0.5 - height * 0.02 + shiftY);
    incoming.position.set(width * 0.5 + shiftX * 1.4, height * 0.5 - height * 0.02 + shiftY * 1.4);
    moteLayer.position.set(shiftX * 1.8, shiftY * 1.8);
    glow.alpha = 0.18 + Math.sin(elapsed / 2600) * 0.05;

    while (motes.live < MOTE_TARGET) spawnMote(width, height);
    motes.update(deltaMS);

    if (plates.length > 1) {
      plateClock += deltaMS;
      if (fadeProgress >= 1 && plateClock >= PLATE_INTERVAL_MS) {
        plateClock = 0;
        fadeProgress = 0;
        plateIndex = (plateIndex + 1) % plates.length;
        incoming.texture = plates[plateIndex];
        const scale = coverScale(incoming.texture, width, height);
        incoming.width = incoming.texture.width * scale;
        incoming.height = incoming.texture.height * scale;
      }
      if (fadeProgress < 1) {
        fadeProgress = Math.min(1, fadeProgress + deltaMS / PLATE_FADE_MS);
        incoming.alpha = fadeProgress;
        if (fadeProgress >= 1) {
          base.texture = incoming.texture;
          const settled = coverScale(base.texture, width, height);
          base.width = base.texture.width * settled;
          base.height = base.texture.height * settled;
          incoming.alpha = 0;
        }
      }
    }
  };

  app.ticker.add(tick);
  app.renderer.on('resize', layout);

  const unsubscribeMotion = motion.subscribe((isReduced) => {
    reduced = isReduced;
    host.dataset.motion = isReduced ? 'reduced' : 'full';
    if (reduced) {
      app.stop();
      motes.clear();
      for (let index = 0; index < MOTE_TARGET_REDUCED; index += 1) {
        spawnMote(app.screen.width, app.screen.height);
      }
      motes.update(1);
      app.render();
    } else {
      app.start();
    }
  });

  window.addEventListener('pointermove', handlePointer, { passive: true });

  host.dataset.motion = reduced ? 'reduced' : 'full';
  host.appendChild(app.canvas);
  layout();
  const moteBudget = reduced ? MOTE_TARGET_REDUCED : MOTE_TARGET;
  for (let index = 0; index < moteBudget; index += 1) {
    spawnMote(app.screen.width, app.screen.height);
  }
  motes.update(1);
  if (reduced) {
    app.render();
  } else {
    app.start();
  }

  return {
    destroy(): void {
      if (disposed) return;
      disposed = true;
      app.stop();
      window.removeEventListener('pointermove', handlePointer);
      unsubscribeMotion();
      app.renderer.off('resize', layout);
      app.ticker.remove(tick);
      motes.destroy();
      releaseTextures(acquired);
      // This scene is the page's backdrop and outlives every room: its teardown
      // is the last one on the page, so it is the right place to drain Pixi's
      // process-wide pools. Scene-scoped teardown deliberately leaves them alone.
      app.destroy({ removeView: true, releaseGlobalResources: true }, { children: true });
    },
  };
}
