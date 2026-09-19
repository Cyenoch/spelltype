import { Application } from 'pixi.js';

/** 后备缓冲区上限，使 4K 竞技场不会分配 4K×4K 的缓冲区。 */
const MAX_BACKING_PIXELS = 2_600_000;

/**
 * 竞技场渲染器及其相关策略：初始化选项、后备缓冲区分辨率、
 * 按需绘制计数器与尺寸变化监听接线。
 */
export interface StageApp {
  readonly app: Application;
  readonly rendererName: string;
  /** 当竞技场回退到 2D canvas 渲染器时为 true。 */
  readonly canvasRenderer: boolean;
  /**
   * 舞台在帧循环之外执行的每一次渲染（初始布局、尺寸变化、减弱动效重绘）都走这里，
   * 因此 `data-paints` 是按需绘制的诚实计数，`data-frames` 则是帧循环驱动的计数。
   */
  paint: () => void;
  /** 针对当前屏幕尺寸重新推导后备缓冲区分辨率。 */
  syncResolution(): void;
  /** 将渲染器的尺寸变化与宿主的尺寸变化转发给 `listener`。 */
  watchResize(listener: () => void): void;
  /** 解除渲染器监听器与宿主观察器的绑定。 */
  stopWatchingResize(): void;
  /** 销毁应用及其画布：在场景图之后、纹理之前。 */
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
    // 高 DPI 同时受设备像素比与总像素预算两重限制。
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
    // 以设备分辨率运行的 2D canvas 比 GPU 路径慢一个数量级；
    // 竞技场保留其全部形状，只是按 1:1 像素绘制。
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
      // 此处不调用 `releaseGlobalResources`：Pixi 的全局池与页面背景共享，
      // 而后者会跨房间存活，在渲染器仍存活时排空它们正是会破坏它的原因。
      // 它们会在页面上最后一个应用消失时被释放。
      app.destroy({ removeView: true }, { children: true });
    },
  };
}
