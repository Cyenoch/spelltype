import { Application } from 'pixi.js';

/** Backing-store ceiling so a 4K arena does not allocate a 4K×4K buffer. */
const MAX_BACKING_PIXELS = 2_600_000;

/**
 * The arena renderer and the policies that belong to it: init options, the
 * backing-store resolution, the on-demand paint counter and the resize wiring.
 */
export interface StageApp {
  readonly app: Application;
  readonly rendererName: string;
  /** True when the arena fell back to the 2D canvas renderer. */
  readonly canvasRenderer: boolean;
  /**
   * Every render the stage performs outside the ticker (initial layout, resize,
   * reduced-motion repaint) goes through here, so `data-paints` is an honest
   * count of on-demand paints and `data-frames` of ticker-driven ones.
   */
  paint: () => void;
  /** Re-derives the backing-store resolution for the current screen size. */
  syncResolution(): void;
  /** Routes renderer resizes and host resizes to `listener`. */
  watchResize(listener: () => void): void;
  /** Detaches the renderer listener and the host observer. */
  stopWatchingResize(): void;
  /** Destroys the application and its canvas: after the scene graph, before the textures. */
  destroy(): void;
}

export async function createStageApp(host: HTMLElement): Promise<StageApp> {
  const rect = host.getBoundingClientRect();
  const cssWidth = Math.max(320, rect.width || host.clientWidth || 960);
  const cssHeight = Math.max(240, rect.height || host.clientHeight || 540);
  const pixelRatio = window.devicePixelRatio || 1;
  const areaBound = Math.sqrt(MAX_BACKING_PIXELS / (cssWidth * cssHeight));

  const app = new Application();
  await app.init({
    backgroundAlpha: 0,
    resizeTo: host,
    antialias: pixelRatio <= 1.5,
    // High-DPI is capped by both the device ratio and the total pixel budget.
    resolution: Math.min(pixelRatio, 1.75, areaBound),
    autoDensity: true,
    autoStart: false,
    eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    preference: ['webgl', 'webgpu', 'canvas'],
    webgl: { powerPreference: 'high-performance' },
    webgpu: { powerPreference: 'high-performance' },
  });
  app.stage.eventMode = 'none';
  app.canvas.setAttribute('aria-hidden', 'true');

  const rendererName = app.renderer.name;
  const canvasRenderer = rendererName === 'canvas';
  if (canvasRenderer) {
    // A 2D canvas at device resolution is slower than the GPU path by an order of
    // magnitude; the arena keeps every shape it has, just at 1:1 pixels.
    app.renderer.resolution = 1;
    app.resize();
  }

  let disposed = false;
  let paintCount = 0;
  let resizeListener: (() => void) | null = null;
  let observer: ResizeObserver | null = null;

  return {
    app,
    rendererName,
    canvasRenderer,

    paint(): void {
      if (disposed) return;
      paintCount += 1;
      host.dataset.paints = String(paintCount);
      app.render();
    },

    syncResolution(): void {
      const width = app.screen.width;
      const height = app.screen.height;
      const resolution = Math.min(
        window.devicePixelRatio || 1,
        canvasRenderer ? 1 : 1.75,
        Math.sqrt(MAX_BACKING_PIXELS / Math.max(1, width * height)),
      );
      if (app.renderer.resolution !== resolution) app.renderer.resolution = resolution;
    },

    watchResize(listener: () => void): void {
      resizeListener = listener;
      app.renderer.on('resize', listener);
      observer = new ResizeObserver(() => {
        if (!disposed) app.queueResize();
      });
      observer.observe(host);
    },

    stopWatchingResize(): void {
      if (resizeListener) app.renderer.off('resize', resizeListener);
      resizeListener = null;
      observer?.disconnect();
      observer = null;
    },

    destroy(): void {
      disposed = true;
      // No `releaseGlobalResources` here: Pixi's global pools are shared with the
      // page backdrop, which stays alive across rooms, and draining them under a
      // live renderer is exactly what corrupts it. They are released when the
      // last application on the page goes away.
      app.destroy({ removeView: true }, { children: true });
    },
  };
}
