import type { Player, RoomSnapshot } from '../../../../shared/protocol';

export type CanvasState = 'pending' | 'ready' | 'failed';
export type RenderMode = 'canvas' | 'dom';

/** 所有战斗界面用于着色的生命值区间。 */
export const LOW_HP_RATIO = 0.35;
export const CRITICAL_HP_RATIO = 0.15;

export interface CombatView {
  /** 席位顺序，与所有战斗界面绘制的顺序一致。 */
  players: Player[];
  self: Player | undefined;
  /** 观察者施法会命中的所有席位：其他所有存活玩家，倒下时为空。 */
  myTargets: Player[];
  /** 所有施法会命中观察者的存活对手 —— 同一组人，从另一侧看。 */
  aimingAtMe: Player[];
}

/**
 * 谁在与谁交战：席位顺序、观察者，以及两个瞄准方向。
 * 一次施法总是覆盖其他所有存活玩家，因此两个集合都是
 * 「除观察者外的全体存活者」—— 且一旦观察者倒下即为空，
 * 因为倒下的施法者既不攻击，也不吸引火力。
 */
export function combatView(snapshot: RoomSnapshot, selfId: string): CombatView {
  const players = [...snapshot.players].sort((a, b) => a.slot - b.slot);
  const self = players.find((player) => player.id === selfId);
  const aliveOthers =
    self && self.eliminatedAt === null
      ? players.filter((player) => player.id !== self.id && player.eliminatedAt === null)
      : [];
  return { players, self, myTargets: aliveOthers, aimingAtMe: aliveOthers };
}

/**
 * 所有战斗界面的视觉列顺序：观察者站在最左，其余席位按席位顺序跟随。
 * 仅用于呈现 —— 席位、瞄准与事件保持各自的权威身份。
 */
export function visualSeatOrder(players: Player[], selfId: string): Player[] {
  const self = players.find((player) => player.id === selfId);
  if (!self) return [...players];
  return [self, ...players.filter((player) => player.id !== selfId)];
}

/** 房间对应稳定的竞技场索引：同一个房间总是绘制同一个竞技场。 */
export function arenaIndex(seed: string): number {
  let hash = 7;
  for (const char of seed) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1_000_003;
  return hash;
}
