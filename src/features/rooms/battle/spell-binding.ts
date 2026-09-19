import type { Element, Player, RoomSnapshot } from '../../../../shared/protocol';
import { spellIconFor } from '../../../pixi/assets';
import type { RestoreMode, TypingRestore, TypingSpellConfig } from './typing';

/** 一份权威快照要求输入框执行的全部操作，按顺序排列。 */
export type SpellBindingOp =
  | { op: 'resetCast' }
  | { op: 'clearField' }
  | { op: 'endField' }
  | { op: 'target'; text: string; artChanged: boolean }
  | { op: 'armGlyphs'; index: number }
  | { op: 'armAim'; element: Element }
  | { op: 'start'; spell: TypingSpellConfig }
  | { op: 'adopt'; restore: TypingRestore; mode: RestoreMode }
  | { op: 'cast'; element: Element | null; hit: boolean }
  | { op: 'focus' };

/**
 * 输入框绑定在哪一道咒文上，以及每份快照对它意味着什么。
 *
 * 绑定按权威身份（对局、spellIndex、草稿代际）依次处理：
 * 同一索引、同一代际的普通确认绝不会重写输入框；
 * 索引或代际比当前绑定更旧的快照无法触及目标或输入框；
 * 更大的代际是一次拒绝恢复；一次真正的重连会重新采用同一代际下已接受的草稿。
 * 可提交的输入框只在阶段为 playing 且快照携带带统计数据的门槛时才存在：
 * 倒计时只预览目标，而缺少门槛的 playing 快照是损坏状态，不会有输入框绑定其上。
 */
export class SpellBinding {
  private matchId = '';
  private index = -1;
  /** 输入框所绑定的草稿代际；未绑定任何内容时为 `-1`。 */
  private epoch = -1;
  private bound = false;
  private target = '';
  private art = '';

  /** 输入框所绑定的咒文索引；无可绑定时为 `-1`。 */
  get boundIndex(): number {
    return this.index;
  }

  /** 针对单份快照的操作，按必须生效的顺序排列。 */
  resolve(
    snapshot: RoomSnapshot,
    self: Player | undefined,
    reconnected: boolean,
  ): SpellBindingOp[] {
    const matchId = snapshot.matchId ?? '';
    const index = self ? self.spellIndex : -1;
    const spell = snapshot.spell;
    const gate = snapshot.selfInputGate;
    const stats = snapshot.selfInputStats;
    const freshMatch = matchId !== this.matchId;
    const ops: SpellBindingOp[] = [];

    if (freshMatch) {
      this.matchId = matchId;
      this.index = -1;
      this.epoch = -1;
      this.bound = false;
      ops.push({ op: 'armGlyphs', index: -1 }, { op: 'resetCast' });
    }

    if (!spell || index < 0) {
      if (this.target) {
        this.target = '';
        ops.push({ op: 'clearField' });
      }
      // 没有任何可绑定内容：输入框必须停止判定、停止发送，
      // 绑定也必须忘记其身份，以便回归的咒文重新绑定。
      this.bound = false;
      this.epoch = -1;
      ops.push({ op: 'endField' });
      return ops;
    }

    // 比已绑定身份更旧的身份（陈旧或乱序的快照）
    // 会在其触及目标或输入框之前被忽略。
    if (!freshMatch && this.index >= 0) {
      if (index < this.index) return ops;
      if (index === this.index && this.bound && gate !== null && gate.draftEpoch < this.epoch) {
        return ops;
      }
    }

    if (spell.text !== this.target) {
      this.target = spell.text;
      const art = spellIconFor(spell.element, index);
      const artChanged = art !== this.art;
      this.art = art;
      ops.push({ op: 'target', text: spell.text, artChanged });
    }

    // 输入框只有拿到真实门槛与其累计统计数据才能判定：
    // 该条件在倒计时（仅预览）以及损坏的无门槛 playing 状态下为 false。
    const committable = snapshot.phase === 'playing' && gate !== null && stats !== null;
    const restoreOf = (): TypingRestore => ({
      matchId,
      spellIndex: index,
      draftEpoch: gate!.draftEpoch,
      draft: snapshot.selfInput,
      stats: { attemptTotal: stats!.attemptTotal, errorTotal: stats!.errorTotal },
    });
    const startOf = (): TypingSpellConfig => ({ ...restoreOf(), target: spell.text });

    if (freshMatch || index > this.index) {
      const accepted = this.index >= 0 && index > this.index;
      this.index = index;
      this.epoch = committable ? gate.draftEpoch : -1;
      this.bound = committable;
      // 新咒文不带任何已庆祝状态开始，因此产生它的那次施法
      // 与本次绑定本身都绝不会触发起打字特效。
      // 起始操作在一步之内携带该咒文已接受的草稿与累计统计数据。
      ops.push(
        { op: 'armGlyphs', index },
        // 渲染器在新咒文下武装，早于输入框采用草稿：
        // 若在那之后才重置，会让进度条、状态行与瞄准字形停为零，
        // 而输入框里却已经装着文本了。
        { op: 'armAim', element: spell.element },
      );
      if (committable) {
        ops.push(
          { op: 'start', spell: startOf() },
          { op: 'cast', element: spell.element, hit: accepted },
        );
        // 进入战斗不应需要一次点击：只聚焦输入框一次，
        // 且仅在没有任何可交互元素已持有焦点时。
        if (!self?.eliminatedAt) ops.push({ op: 'focus' });
      } else {
        ops.push({ op: 'endField' });
      }
      return ops;
    }

    // 从这里开始身份相同。
    if (!committable) {
      this.bound = false;
      ops.push({ op: 'endField' });
      return ops;
    }
    if (!this.bound) {
      // 以未变的索引进入 playing（倒计时预览之后，
      // 或损坏的无门槛状态之后）：用真实门槛与统计数据完成绑定。
      this.epoch = gate.draftEpoch;
      this.bound = true;
      ops.push({ op: 'start', spell: startOf() });
      if (!self?.eliminatedAt) ops.push({ op: 'focus' });
      return ops;
    }
    if (gate.draftEpoch > this.epoch) {
      // 一次拒绝在新的代际下恢复了草稿：精确采用它。
      const restore = restoreOf();
      this.epoch = gate.draftEpoch;
      ops.push({ op: 'adopt', restore, mode: 'recovery' });
      return ops;
    }
    if (reconnected && gate.draftEpoch === this.epoch) {
      // 真正的重连会在同一代际下与服务端真值对账一次。
      ops.push({ op: 'adopt', restore: restoreOf(), mode: 'reconnect' });
    }
    // 其余情况都是已绑定代际下的普通确认：输入框不被重写，
    // 因此迟到的快照绝不可能撤销玩家已输入的内容。
    return ops;
  }
}
