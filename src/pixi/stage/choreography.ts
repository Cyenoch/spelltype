import type { Container } from 'pixi.js';
import type { Fighter } from '../fighter/fighter';
import type { FxLayer } from '../effects/layer';
import type { Seating } from './seating';
import type { Element, Player, RoomSnapshot } from '../../../shared/protocol';

/** 减弱动效下，命中先落在它该落的位置，随后再让效果追赶上来。 */
const SETTLE_STEP_MS = 160;
/** 第二次确认落在同一帧；收尾流程会等它过去。 */
const SETTLE_HOLD_MS = 900;
const SETTLE_CATCH_UP_MS = 2400;

/** 对局级节拍所读取并驱动的全部内容。 */
export interface ChoreographyDeps {
  /** 竞技场场景图的根节点；画面震动会移动它。 */
  world: Container;
  /** 实时的屏幕矩形，供倒计时节拍读取。 */
  screen: { width: number; height: number };
  fighters: readonly Fighter[];
  seating: Seating;
  fx: FxLayer;
  /** 在帧循环之外按 `deltaMS` 推进特效、斗士与字形。 */
  frame: (deltaMS: number) => void;
  /** 渲染一帧，并将其计入按需绘制次数。 */
  paint: () => void;
}

export interface Choreography {
  /** 屏幕震动冲量；帧更新会将其逐渐衰减掉。 */
  shake(amount: number): void;
  /** 单帧内的震动衰减、倒计时开场特效与胜利节拍。 */
  update(
    deltaMS: number,
    phase: RoomSnapshot['phase'],
    occupancy: readonly (Player | null)[],
    element: Element,
  ): void;
  /** 清除震动并将世界重新居中。 */
  calm(): void;
  /** 减弱动效：绘制已收尾的那一帧，并安排收尾流程。 */
  settle(): void;
  /** 取消尚未执行的收尾流程。 */
  stopSettle(): void;
  reset(): void;
}

export function createChoreography(deps: ChoreographyDeps): Choreography {
  const { world, screen, fighters, seating, fx, frame, paint } = deps;
  let shakeLevel = 0;
  let victoryApplied = false;
  let openingPlayed = false;
  let settleTimer: number | null = null;

  return {
    shake(amount: number): void {
      shakeLevel = Math.max(shakeLevel, amount);
    },

    update(deltaMS, phase, occupancy, element): void {
      if (shakeLevel > 0) {
        shakeLevel = Math.max(0, shakeLevel - deltaMS * 0.022);
        world.position.set(
          (Math.random() - 0.5) * shakeLevel,
          (Math.random() - 0.5) * shakeLevel * 0.6,
        );
      } else if (world.position.x !== 0 || world.position.y !== 0) {
        world.position.set(0, 0);
      }

      if (phase === 'countdown' && !openingPlayed && occupancy.some((player) => player !== null)) {
        openingPlayed = true;
        const centreX = screen.width / 2;
        const centreY = screen.height * 0.9;
        fx.groundWave(centreX, centreY, 0x9f92ff, 1.3);
        fx.typingSpark(centreX, centreY - 40, element, 6);
        for (let slot = 0; slot < fighters.length; slot += 1) {
          if (occupancy[slot]) fighters[slot].flourish();
        }
      }

      if (phase !== 'finished' || victoryApplied) return;
      victoryApplied = true;
      const winner = occupancy.findIndex((player) => player !== null && player.rank === 1);
      for (let slot = 0; slot < fighters.length; slot += 1) {
        const player = occupancy[slot];
        if (!player) continue;
        const victorious = slot === winner;
        fighters[slot].setVictory(victorious);
        if (!victorious) continue;
        const seat = seating.geometry[slot];
        fx.victoryPillar(
          seat.x,
          Math.max(34, seat.feetY - seat.height - 18),
          seat.feetY - 18,
          0xffd79a,
        );
      }
    },

    calm(): void {
      shakeLevel = 0;
      world.position.set(0, 0);
    },

    settle(): void {
      frame(SETTLE_STEP_MS);
      paint();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        frame(SETTLE_CATCH_UP_MS);
        fx.clear();
        paint();
      }, SETTLE_HOLD_MS);
    },

    stopSettle(): void {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = null;
    },

    reset(): void {
      victoryApplied = false;
      openingPlayed = false;
    },
  };
}
