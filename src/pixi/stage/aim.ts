import { Container, Graphics, Sprite } from 'pixi.js';
import { spellIconFor } from '../assets';
import { ELEMENT_COLORS } from '../../ui/elements';
import type { FxTextures } from '../effects/shapes';
import type { Seating } from './seating';
import type { StageAssets } from './assets';
import type { Element, Player, RoomSnapshot } from '../../../shared/protocol';

/** 绘制在施法者与每个锁定目标之间的微尘数量。 */
const AIM_MOTES = 4;

/** 目标指示读数：通往每个锁定目标的连接光束，以及施法者的徽记。 */
export interface AimLayer {
  /** 连接光束与徽记；舞台将其放入场景图。 */
  readonly view: Container;
  /**
   * 重绘连接光束；目标未变化时会短路，而 `force` 可绕开该检查，
   * 供已知几何发生变化的调用方使用。
   */
  drawAim(
    selfSlot: number,
    occupancy: readonly (Player | null)[],
    phase: RoomSnapshot['phase'],
    element: Element,
    force?: boolean,
  ): void;
  /** 施法者的徽记：当前施法的咒文符印，或该元素的符文。 */
  drawEmblem(element: Element, index: number, phase: RoomSnapshot['phase'], selfSlot: number): void;
  /** 对局进行中时，让连接光束随施法者的蓄力脉动。 */
  pulse(clock: number, progress: number, playing: boolean): void;
  /** 让徽记旋转；隐藏状态下的徽记不会移动。 */
  spin(deltaMS: number): void;
  clear(): void;
}

/**
 * 施法者下一次施法会命中的所有席位：其他所有存活玩家。
 * 施法者本人与任何已被淘汰者绝不会成为目标，
 * 因此倒下的观察者不会绘制任何内容，已阵亡的席位也不会残留准星。
 */
function aimSlots(selfSlot: number, occupancy: readonly (Player | null)[]): number[] {
  if (selfSlot < 0) return [];
  const self = occupancy[selfSlot];
  if (!self || self.eliminatedAt !== null) return [];
  const slots: number[] = [];
  for (let slot = 0; slot < occupancy.length; slot += 1) {
    const player = occupancy[slot];
    if (slot !== selfSlot && player && player.eliminatedAt === null) slots.push(slot);
  }
  return slots;
}

export function createAimLayer(
  seating: Seating,
  textures: FxTextures,
  assets: StageAssets,
): AimLayer {
  const view = new Container();
  const tether = new Graphics();
  const emblem = new Sprite(textures.glow);
  emblem.anchor.set(0.5);
  emblem.blendMode = 'add';
  emblem.alpha = 0.42;
  emblem.visible = false;
  view.addChild(tether, emblem);

  const stance = { x: 0, y: 0 };
  const target = { x: 0, y: 0 };
  let signature = '';

  return {
    view,

    drawAim(selfSlot, occupancy, phase, element, force = false): void {
      const targetSlots = aimSlots(selfSlot, occupancy);
      const next = `${selfSlot}|${phase}|${element}|${targetSlots.join(',')}`;
      if (!force && next === signature) return;
      signature = next;
      tether.clear();
      if (targetSlots.length === 0 || phase !== 'playing') return;
      seating.chest(selfSlot, stance);
      const color = ELEMENT_COLORS[element];
      // 每个存活对手一条连接光束：整个场地读起来就是本次施法的落点区域，
      // 因为房间会把每一次施法分摊到他们所有人身上。
      for (const targetSlot of targetSlots) {
        seating.chest(targetSlot, target);
        const dx = target.x - stance.x;
        const dy = target.y - stance.y;
        if (Math.hypot(dx, dy) < 1) continue;

        const targetY = seating.geometry[targetSlot].feetY - 2;
        // 几颗发光微尘，而不是一条直线：它们随距离淡出，
        // 使这条连接读起来像魔法飘向锁定目标。
        for (let index = 0; index < AIM_MOTES; index += 1) {
          const at = (index + 1) / (AIM_MOTES + 1);
          const strength = 1 - at * 0.7;
          const x = stance.x + dx * at + Math.sin(index * 2.4) * 7;
          const y = stance.y + dy * at + Math.cos(index * 1.9) * 4;
          tether.circle(x, y, 4.5).fill({ color, alpha: 0.1 * strength });
          tether.circle(x, y, 1.9).fill({ color, alpha: 0.34 * strength });
        }

        // 锁定标记接管目标脚下的地面光环，使它读起来像刻意的瞄准准星，
        // 而不是脚边一个随意画出的圆圈。
        tether.ellipse(target.x, targetY, 46, 15).stroke({ width: 2, color, alpha: 0.55 });
        tether.ellipse(target.x, targetY, 34, 11).stroke({ width: 1, color, alpha: 0.4 });
        for (let index = 0; index < 4; index += 1) {
          const angle = (Math.PI * 2 * index) / 4 + Math.PI / 4;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          tether
            .moveTo(target.x + cos * 40, targetY + sin * 13)
            .lineTo(target.x + cos * 54, targetY + sin * 18)
            .stroke({ width: 3, color, alpha: 0.5, cap: 'round' });
        }
      }
    },

    drawEmblem(element, index, phase, selfSlot): void {
      const icon = assets.request(spellIconFor(element, index));
      if (icon) {
        emblem.texture = icon;
        emblem.tint = 0xffffff;
      } else {
        // 生成的咒文符印是按需获取的；在它到达之前（或始终未到达时），
        // 用该元素的符文顶替。
        emblem.texture = textures.rune[element];
        emblem.tint = ELEMENT_COLORS[element];
      }
      emblem.visible = phase === 'playing';
      if (selfSlot < 0) return;
      const seat = seating.geometry[selfSlot];
      if (!seat.present) return;
      // 位于施法者自身身体之后，使它读起来像施法光晕，
      // 而不是画在脸上的线框图。
      emblem.position.set(seat.x, seat.feetY - seat.height * 0.66);
      const size = seat.height * 0.42;
      emblem.width = size;
      emblem.height = size;
    },

    pulse(clock, progress, playing): void {
      if (playing) tether.alpha = 0.45 + Math.sin(clock / 700) * 0.18 + progress * 0.1;
    },

    spin(deltaMS): void {
      if (emblem.visible) emblem.rotation += deltaMS * 0.0005;
    },

    clear(): void {
      tether.clear();
      emblem.visible = false;
    },
  };
}
