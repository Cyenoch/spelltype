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
 * 实时的战斗竞技场。
 *
 * `update` 接收权威快照，`typing` 接收本地已确认的前缀；
 * 二者都不决定任何与伤害有关的内容。命中源自 `CombatEvent`，
 * 并在每场对局内按 `(matchId, seq)` 去重，
 * 因此重新下发房间事件环的重连绝不会重放旧攻击。
 */
export interface BattleStage {
  update(snapshot: RoomSnapshot, selfId: string): void;
  typing(progress: number, element: Element): void;
  /** 当仍有攻击在排队或飞行中时为 true：结算界面等最后一击落地。 */
  settling(): boolean;
  destroy(): void;
}

const SLOT_COUNT = 4;
/** 帧时长钳制：被切到后台的标签页返回时，不得让所有效果瞬移。 */
const MAX_FRAME_MS = 48;

export async function createBattleStage(host: HTMLElement): Promise<BattleStage> {
  const stageApp = await createStageApp(host);
  const app = stageApp.app;
  const assets = createStageAssets();

  /**
   * 美术资源引导。渲染器先于美术资源关闭：
   * 在运行中的应用仍把某张纹理源绑定到着色器时就销毁它，
   * 正是会让 Pixi 警告「资源已销毁却仍处于绑定状态」的原因。
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
  // 目标连接光束位于斗士之后，因此绝不会横穿角色绘制：
  // 它在两人之间的空隙中被读取，就像真实的瞄准视线。
  world.addChild(arena.back, arena.floor, fx.ground, aim.view, fighterLayer, fx.air, arena.fore);

  const advance = (deltaMS: number): void => {
    fx.update(deltaMS);
    for (const fighter of fighters) fighter.update(deltaMS, 0.5);
    glyphs.update(deltaMS);
  };

  /** 丢弃所有存活中的效果与粒子：竞技场随即呈现为空场景。 */
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
    // 观察者自己读作最左侧 —— 与 DOM 顶部标签所用的顺序一致
    // （battle-view 中的 `visualSeatOrder`）。列顺序纯属视觉层面：
    // 席位、目标与事件保持各自的权威身份，而每个锚点（胸口、脚部进度条、
    // 连接光束、弹道）都通过 `seating` 按席位反查。
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
    // TickerPlugin 会在该回调之后立即渲染同一帧，
    // 因此帧循环驱动的帧只在此处计数，别处不再重复。
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
      // 在切换模式之前先结算已确认的命中；丢弃在途弹道会丢失其命中效果
      // 与被推迟的淘汰反馈。
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

    settling(): boolean {
      return combat.busy();
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
      // 自有纹理只在渲染器之后销毁：在运行中的应用仍将其绑定到着色器时销毁纹理源，
      // 正是 Pixi 会发出警告的情形。
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
