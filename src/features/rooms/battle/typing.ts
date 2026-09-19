import { normalizeSpellInput } from '../../../../shared/spell-input';
import { prefixLength } from '../../../ui/format';
import { attachInputGuards, clampInput, countEdit } from './typing-input';

/**
 * 一个已绑定咒文身份的权威状态：属于哪场对局与哪个咒文游标、
 * 携带哪一代草稿、被接受的确切草稿文本，
 * 以及截至该草稿时的整场累计尝试/错误计数。
 */
export interface TypingRestore {
  matchId: string;
  /** 该草稿所属的、玩家单调递增、从零开始的咒文游标。 */
  spellIndex: number;
  /** 服务端的草稿代际：每次因拒绝而恢复都会递增。 */
  draftEpoch: number;
  draft: string;
  stats: { attemptTotal: number; errorTotal: number };
}

export interface TypingSpellConfig extends TypingRestore {
  target: string;
}

export interface TypingLocalState {
  /** 可安全用于判定的值：已确认的文本，绝不是正在拼写的临时文本。 */
  text: string;
  progress: number;
  targetLength: number;
  attempts: number;
  errors: number;
  accuracy: number | null;
  /** 本地已完成；服务端尚未确认。 */
  pending: boolean;
  /** 该咒文已定局：已阵亡、截止时间已过，或对局已结束。 */
  locked: boolean;
  composing: boolean;
}

export interface TypingCommit {
  matchId: string;
  spellIndex: number;
  draftEpoch: number;
  text: string;
  complete: boolean;
  progress: number;
}

export type RestoreMode = 'reconnect' | 'recovery';

export interface TypingCallbacks {
  /** 当快照确实已离开客户端时返回 true。 */
  onCommit(commit: TypingCommit): boolean;
  onLocalState(state: TypingLocalState): void;
  onPasteBlocked(): void;
  onTooLong(): void;
}

/**
 * 掌管咒文输入框。
 *
 * 它强制执行的规则：
 * - 正在进行的输入法（IME）拼写绝不被判定、绝不被发送、也绝不被打断：
 *   进度与错误均依据最近一次确认的值计算，绝不依据临时的拼写文本；
 * - 每一次确认值变化都会立即发送（不合并），
 *   因此一个打错又被改正的错误仍会作为一次尝试到达服务端；
 * - 插入与替换计为尝试（已撤回的错误仍被计入），纯粹的删除不计任何东西；
 * - 本地完成只是一个*待定*状态。输入框保持可编辑：房间会原子地结算该次命中，
 *   然后推进 `spellIndex`，因此完成后多打的字符会作为陈旧输入被拒绝，
 *   而不会造成第二次命中。判定一次施法是否发生过的是权威快照，绝不是本控制器；
 * - 采用服务端状态的方式只有一种：`restoreInput`（以及能感知草稿与统计数据的 `startSpell`）。
 *   两者都会捕获发送时所携带的代际；任何地方都不会从稍后的快照重新读取代际。
 *   采用过程会重写输入框而不计入尝试、不触发效果，并且绝不把代际回退：
 *   一次恢复需要严格更大的代际，一次重连则需要相同或更大的代际；
 * - 在拼写过程中到达的权威状态会被暂存（候选文本绝不被触碰），
 *   并在 IME 结束拼写时应用 —— 早于该次拼写自身的文本可能被提交的时刻，
 *   因此被拒绝的草稿绝不可能复活。
 */
export class TypingController {
  private target = '';
  private matchId = '';
  private spellIndex = 0;
  /** 本控制器发送时所携带的草稿代际。 */
  private draftEpoch = 0;
  private active = false;
  private composing = false;
  private lastValue = '';
  private lastSent: string | null = null;
  private attempts = 0;
  private errors = 0;
  private pendingComplete = false;
  private locked = false;
  private lastPushDelivered = true;
  /** 在拼写过程中到达的咒文，待 IME 结束拼写后应用。 */
  private deferredStart: TypingSpellConfig | null = null;
  /** 在拼写过程中到达的一次恢复；最新的一次胜出。 */
  private deferredRestore: { restore: TypingRestore; mode: RestoreMode } | null = null;
  /**
   * 一次权威采用所丢弃的拼写文本，以及取代它的草稿。
   * 浏览器会在 `compositionend` 之后再次把被丢弃的值作为一个 `input` 事件送达；
   * 该事件会被以已接受的草稿作答（不计入尝试、不发送），
   * 而任何其他值则照常判定，因此真正的下一次击键绝不会被吞掉。
   */
  private staleImeText: { committed: string; accepted: string } | null = null;

  private detachGuards: () => void = () => undefined;

  constructor(
    private readonly textarea: HTMLTextAreaElement,
    private readonly callbacks: TypingCallbacks,
  ) {
    textarea.addEventListener('input', this.handleInput);
    textarea.addEventListener('compositionstart', this.handleCompositionStart);
    textarea.addEventListener('compositionend', this.handleCompositionEnd);
    this.detachGuards = attachInputGuards(textarea, {
      onRefused: () => this.callbacks.onPasteBlocked(),
      isComposing: () => this.composing,
    });
  }

  destroy(): void {
    this.textarea.removeEventListener('input', this.handleInput);
    this.textarea.removeEventListener('compositionstart', this.handleCompositionStart);
    this.textarea.removeEventListener('compositionend', this.handleCompositionEnd);
    this.detachGuards();
  }

  get isComposing(): boolean {
    return this.composing;
  }

  get currentSpellIndex(): number {
    return this.spellIndex;
  }

  /**
   * 开始（或重新开始）一道咒文：计数器从绑定所捕获的整场累计统计数据续接，
   * 输入框则采用该咒文已接受的草稿。
   * 单道咒文的尝试/错误历史绝不会被到达的快照重置 ——
   * 只有这条绑定才会建立新的基线。
   *
   * 玩家正处在拼写过程中时到达的新咒文会被推迟：
   * 房间会在某次施法被接受的瞬间推进 `spellIndex`，
   * 而在 IME 活跃期间清空输入框会打乱浏览器的拼写状态 ——
   * 因此新咒文会在拼写结束时才被应用，
   * 而属于上一道咒文的文本会被丢弃，而不是被提交上去。
   */
  startSpell(config: TypingSpellConfig): void {
    if (this.composing) {
      this.deferredRestore = null;
      this.pendingComplete = false;
      this.deferredStart = config;
      this.emit();
      return;
    }
    this.applyStart(config, null);
  }

  private applyStart(config: TypingSpellConfig, discardedComposition: string | null): void {
    this.staleImeText =
      discardedComposition === null
        ? null
        : { committed: discardedComposition, accepted: config.draft };
    this.target = config.target;
    this.matchId = config.matchId;
    this.spellIndex = config.spellIndex;
    this.draftEpoch = config.draftEpoch;
    this.active = true;
    this.attempts = config.stats.attemptTotal;
    this.errors = config.stats.errorTotal;
    this.pendingComplete = false;
    this.locked = false;
    this.lastSent = config.draft;
    this.deferredRestore = null;
    this.lastValue = config.draft;
    if (this.textarea.value !== config.draft) this.textarea.value = config.draft;
    this.moveCaretToEnd();
    this.emit();
  }

  /** 权威锁定：本场对局不再接受任何输入。 */
  setLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    if (locked) {
      this.deferredStart = null;
      this.deferredRestore = null;
      this.pendingComplete = false;
    }
    this.emit();
  }

  /** 对局已结束或该玩家已出局：仅展示，不做任何判定。 */
  endSpell(): void {
    this.active = false;
    // 已结算的对局会取消所有被推迟的动作：
    // 无论是暂存的咒文还是暂存的恢复，都不得在 compositionend 时让输入复活。
    this.deferredStart = null;
    this.deferredRestore = null;
    this.staleImeText = null;
    if (this.pendingComplete) {
      this.pendingComplete = false;
      this.emit();
    }
  }

  /**
   * 唯一的权威采用入口。以服务端已接受的草稿与统计数据为输入框重建基线：
   * 页面刷新、重连以及因拒绝而触发的恢复都会落到这里 ——
   * 绝不通过重新发送本地编辑，也绝不计入一次尝试。
   *
   * 身份优先：针对另一场对局或另一个咒文游标的恢复会被忽略
   * （只有 `startSpell` 可以切换身份）。代际其次：
   * 恢复必须携带比当前草稿严格更大的代际，重连则需相同或更大的代际 ——
   * 任何更旧的都只是本控制器已经走过的某个草稿的回声。
   */
  restoreInput(state: TypingRestore, mode: RestoreMode): void {
    const start = this.deferredStart;
    if (start) {
      if (state.matchId !== start.matchId || state.spellIndex !== start.spellIndex) return;
      if (state.draftEpoch < start.draftEpoch) return;
      this.deferredStart = { ...start, ...state };
      return;
    }
    if (!this.active) return;
    if (state.matchId !== this.matchId || state.spellIndex !== this.spellIndex) return;
    if (mode === 'recovery') {
      if (state.draftEpoch <= this.draftEpoch) return;
    } else if (state.draftEpoch < this.draftEpoch) {
      return;
    }
    if (this.deferredRestore && state.draftEpoch < this.deferredRestore.restore.draftEpoch) return;
    if (this.composing) {
      // 保持候选文本及其选区不动：暂存最新的权威状态，
      // 并停止提交旧代际的文本。compositionend 处理器会在任何提交可能逃逸之前采用它。
      this.deferredRestore = { restore: state, mode };
      if (this.pendingComplete) {
        this.pendingComplete = false;
        this.emit();
      }
      return;
    }
    this.adoptRestore(state);
  }

  private adoptRestore(state: TypingRestore): void {
    this.deferredRestore = null;
    this.staleImeText = null;
    this.draftEpoch = state.draftEpoch;
    this.attempts = state.stats.attemptTotal;
    this.errors = state.stats.errorTotal;
    this.pendingComplete = false;
    this.showAccepted(state.draft);
  }

  /** 仅展示的写入：不计尝试、不发送、不改变锁定状态。 */
  private showAccepted(draft: string): void {
    if (this.textarea.value !== draft) this.textarea.value = draft;
    this.lastValue = draft;
    this.lastSent = draft;
    this.moveCaretToEnd();
    this.emit();
  }

  private moveCaretToEnd(): void {
    const end = this.textarea.value.length;
    try {
      this.textarea.setSelectionRange(end, end);
    } catch {
      // 部分浏览器会拒绝对隐藏输入框调用选区 API；打字仍然可用。
    }
  }

  private readonly handleCompositionStart = (): void => {
    this.composing = true;
    this.emit();
  };

  private readonly handleCompositionEnd = (): void => {
    this.composing = false;
    if (!this.active && !this.deferredStart) return;
    if (this.locked) {
      this.deferredStart = null;
      this.deferredRestore = null;
      return;
    }
    const discarded = this.textarea.value;
    const start = this.deferredStart;
    if (start) {
      // 该次拼写属于房间已经结算的那道咒文：用其草稿与统计数据绑定新身份，
      // 并记住被丢弃的拼写文本，使浏览器针对旧目标后续送达的 `input`
      // 回退到已采用的草稿，而不是被提交上去。
      this.deferredStart = null;
      this.applyStart(start, discarded);
      return;
    }
    const deferred = this.deferredRestore;
    if (deferred) {
      // 权威采用优先于拼写结束后的值：该草稿在服务端被拒绝了（或被重新同步了），
      // 因此采用它 —— 忽略刚输入的内容才是诚实的做法。
      // 正是这一优先级，使一次被拒绝的完成永远不会被提交上去。
      this.deferredRestore = null;
      this.adoptRestore(deferred.restore);
      this.staleImeText = { committed: discarded, accepted: deferred.restore.draft };
      return;
    }
    this.commitValue(discarded);
  };

  private readonly handleInput = (event: Event): void => {
    const composing = this.composing || (event instanceof InputEvent && event.isComposing === true);
    if (composing) {
      // 临时的拼写文本绝不被判定；只重新渲染状态。
      this.emit();
      return;
    }
    const stale = this.staleImeText;
    if (stale !== null && this.textarea.value === stale.committed) {
      // 浏览器重放了被丢弃的拼写值：精确回退到已接受的草稿，
      // 同时保持 lastValue/lastSent 不变，因此既不计入尝试也不发送。
      // 该标记只用一次：此后若某个值恰好再次匹配，那就是一次真实的击键，必须被判定。
      this.staleImeText = null;
      if (this.textarea.value !== stale.accepted) this.textarea.value = stale.accepted;
      this.lastValue = stale.accepted;
      this.lastSent = stale.accepted;
      this.emit();
      return;
    }
    this.staleImeText = null;
    this.commitValue(this.textarea.value);
  };

  private commitValue(rawNext: string): void {
    if (!this.active) return;
    const clamped = clampInput(rawNext);
    const next = normalizeSpellInput(clamped.text, this.target);
    if (next !== rawNext) {
      const { selectionStart, selectionEnd, selectionDirection } = this.textarea;
      this.textarea.value = next;
      this.textarea.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
    }
    if (clamped.truncated) this.callbacks.onTooLong();
    if (next === this.lastValue) {
      this.emit();
      return;
    }
    const previous = this.lastValue;
    this.lastValue = next;
    const edit = countEdit(previous, next, this.target);
    this.attempts += edit.inserted;
    this.errors += edit.errors;

    const finished = this.target !== '' && next === this.target;
    this.pendingComplete = finished && !this.locked;

    // 每一次确认的变化都即时提交：服务端的准确率统计必须看到错误字符，
    // 即便它们立刻就被改正了。
    this.pushNow();
    this.emit();
  }

  private pushNow(): void {
    // 一条暂存的起始或恢复指令拥有输入框的下一句话：
    // 旧代际仍持有的任何内容都不得到达服务端。
    if (
      this.locked ||
      this.composing ||
      !this.active ||
      this.deferredStart !== null ||
      this.deferredRestore !== null
    ) {
      return;
    }
    const text = this.textarea.value;
    if (text === this.lastSent) {
      this.lastPushDelivered = true;
      return;
    }
    this.lastSent = text;
    this.lastPushDelivered = this.callbacks.onCommit({
      matchId: this.matchId,
      spellIndex: this.spellIndex,
      draftEpoch: this.draftEpoch,
      text,
      complete: this.pendingComplete,
      progress: prefixLength(this.target, text),
    });
    if (!this.lastPushDelivered) this.lastSent = null;
  }

  private emit(): void {
    // 拼写过程中，只有已确认的值可用于判定或作为进度展示；
    // 临时的候选文本不得制造虚假的错误。
    const text = this.composing ? this.lastValue : this.textarea.value;
    this.callbacks.onLocalState({
      text,
      progress: prefixLength(this.target, text),
      targetLength: Array.from(this.target).length,
      attempts: this.attempts,
      errors: this.errors,
      accuracy: this.attempts === 0 ? null : (this.attempts - this.errors) / this.attempts,
      pending: this.pendingComplete,
      locked: this.locked,
      composing: this.composing,
    });
  }
}
