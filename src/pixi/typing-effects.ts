import { Application, Graphics, type Texture, type Ticker } from 'pixi.js';
import { ELEMENT_ORDER } from './assets';
import { ELEMENT_COLORS, ELEMENT_CORE } from '../ui/elements';
import { motion } from '../ui/motion';
import { SparkPool } from './particles';
import { drawElementShard } from './effects/shapes';
import type { Element } from '../../shared/protocol';

/**
 * 每次确认输入的字符（含错误字符）所触发的 Power Mode 火花。
 * 一个小型 Canvas 应用叠加在原生咒文输入框之上。
 * 四个固定容量的池限定了粒子总数；当所有拖尾都消散后帧循环即休眠。
 * 爆发仅局限于字形附近，绝不会移动句子或战场。
 */
export interface TypingEffects {
  /** 每个确认字符触发一次局部爆发；错误字符使用红色而非元素色。 */
  emit(x: number, y: number, element: Element, error: boolean): void;
  /** 重新读取宿主尺寸；同时通过自身观察自动触发。 */
  resize(): void;
  destroy(): void;
}

/** 池的总容量，在四种元素形状间均分。 */
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
    // 在确认字符到来之前不播放任何动画。
    autoStart: false,
    antialias: false,
    preference: ['canvas'],
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
    // 纯装饰层，所有交互都属于其下方的 DOM 文本（宿主已设置 `pointer-events: none`）。
    // 应用一经初始化，事件系统便会在 document 上绑定捕获阶段的指针监听器，
    // 因此既然这里没有可命中的对象，就关闭全部四类事件特性并让舞台保持非交互：
    // 该画布的任何事件都不会被归一化、映射或命中测试。
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
    // 用最后一帧清空画布，此后该叠加层完全不产生开销。
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
      // 柔和的左向漂移既不会遮挡未读文本，也不会像喷气那样突兀。
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
      // 先销毁渲染器：它为每张已绘制纹理持有一个绑定组，且只在自身销毁时释放，
      // 因此若在应用仍存活时销毁碎片的纹理源，会报出「已销毁却仍处于绑定状态」。
      app.destroy({ removeView: true }, { children: true });
      for (const texture of owned) {
        if (!texture.destroyed) texture.destroy(true);
      }
    },
  };
}
