import { createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from 'solid-js';
import type { Element, Player, RoomSnapshot } from '../../../../shared/protocol';
import type { ServerClock } from '../../../app/clock';
import { TypingController, type TypingCommit, type TypingLocalState } from './typing';
import type { BattleStage } from '../../../pixi/stage/battle-stage';
import type { TypingEffects } from '../../../pixi/typing-effects';
import { createGlyphFeedback, type GlyphFeedback } from './battle-glyphs';
import type { CanvasState } from './battle-view';
import { SpellBinding, type SpellBindingOp } from './spell-binding';

const IDLE_LOCAL: TypingLocalState = {
  text: '',
  progress: 0,
  targetLength: 0,
  attempts: 0,
  errors: 0,
  accuracy: null,
  pending: false,
  locked: false,
  composing: false,
};

export interface BattleHosts {
  canvas: HTMLElement;
  fx: HTMLElement;
}

export interface BattleTypingProps {
  snapshot: RoomSnapshot;
  selfId: string;
  /** 仅由真正的重连递增；随后到达的那份快照会对账一次。 */
  reconnectedMarker: number;
  clock: ServerClock;
  /** 房间级重绘心跳：在标签页可见时驱动那个唯一的全局时钟。 */
  tick: number;
  stage: BattleStage | null;
  typingFx: TypingEffects | null;
  fxState: CanvasState;
  onHosts(hosts: BattleHosts): void;
  onCommit(commit: TypingCommit): boolean;
  onPasteBlocked(): void;
}

export interface BattleTyping {
  phase(): RoomSnapshot['phase'];
  self(): Player | undefined;
  eliminated(): boolean;
  finished(): boolean;
  target(): string;
  targetChars(): string[];
  local(): TypingLocalState;
  /** 输入框的确切内容：IME 打开时为正在拼写的值。 */
  fieldText(): string;
  remainingMs(): number | null;
  /**
   * 距离当前咒文输入门槛开启的剩余时间，取自绘制战斗时钟的同一个房间心跳：
   * 就绪后为 `0`，无门槛时为 `null`。
   * 客户端绝不自行计算该规则 —— 它只渲染服务端的 `notBefore`。
   */
  gateRemainingMs(): number | null;
  castState(): 'idle' | 'pending' | 'done';
  castElement(): Element | null;
  tip(): string;
  pasteMessage(): string;
  /** 装饰性效果图层自身的状态，显示在咒文字形之上。 */
  fxState(): CanvasState;
  artFailed(): boolean;
  onArtFailed(): void;
  /** 效果画布之上的字符及其粒子爆发。 */
  readonly glyphs: GlyphFeedback;
  attachTextarea(el: HTMLTextAreaElement): void;
  attachColumn(el: HTMLElement): void;
  attachFxHost(el: HTMLElement): void;
  attachCanvasHost(el: HTMLElement): void;
}

/**
 * 掌管战斗输入站：绑定到玩家当前咒文的输入框、施法横幅，以及两个可选的渲染器宿主。
 * 它暴露的每个数字都来自权威快照或本地输入框 —— 绝不来自待定的写入。
 */
export function createBattleTyping(props: BattleTypingProps): BattleTyping {
  let textarea: HTMLTextAreaElement | null = null;
  let fxHost: HTMLElement | null = null;
  let canvasHost: HTMLElement | null = null;
  let column: HTMLElement | null = null;
  let typing: TypingController | null = null;

  const [local, setLocal] = createSignal<TypingLocalState>(IDLE_LOCAL);
  const [target, setTarget] = createSignal('');
  const [castState, setCastState] = createSignal<'idle' | 'pending' | 'done'>('idle');
  const [castElement, setCastElement] = createSignal<Element | null>(null);
  const [tip, setTip] = createSignal('');
  const [pasteMessage, setPasteMessage] = createSignal('');
  const [artFailed, setArtFailed] = createSignal(false);

  const binding = new SpellBinding();
  let lastPhase = '';
  let seenMarker = props.reconnectedMarker;
  let warnedLastThirty = false;

  const phase = createMemo(() => props.snapshot.phase);
  const selfPlayer = createMemo(() =>
    props.snapshot.players.find((player) => player.id === props.selfId),
  );
  const targetChars = createMemo(() => Array.from(target()));
  const finished = createMemo(() => phase() === 'finished');
  const eliminated = createMemo(() => Boolean(selfPlayer() && selfPlayer()!.eliminatedAt !== null));

  const glyphs = createGlyphFeedback({
    snapshot: () => props.snapshot,
    selfId: () => props.selfId,
    layer: () => props.typingFx,
    isReady: () => props.fxState === 'ready',
    column: () => column,
    fxHost: () => fxHost,
  });

  const remainingMs = createMemo(() => {
    const snapshot = props.snapshot;
    // 房间的心跳即是重绘节拍；在此读取它会重新求值时钟。
    void props.tick;
    const active =
      (snapshot.phase === 'playing' || snapshot.phase === 'countdown') && snapshot.deadline > 0;
    return active ? props.clock.remainingMs(snapshot.deadline) : null;
  });

  const gateRemainingMs = createMemo(() => {
    // 与战斗截止时间源自同一个心跳、同一个时钟，
    // 因此两个倒计时一起走动，无需第二个定时器。
    void props.tick;
    const gate = props.snapshot.selfInputGate;
    if (!gate) return null;
    return props.clock.remainingMs(gate.notBefore);
  });

  const setCast = (element: Element | null, state: 'idle' | 'pending' | 'done') => {
    setCastElement(element);
    setCastState(state);
  };

  /** 聚焦输入框，除非玩家已经停留在某个可交互控件上。 */
  const focusInput = () => {
    const active = document.activeElement;
    const interactive =
      active instanceof HTMLInputElement ||
      active instanceof HTMLTextAreaElement ||
      active instanceof HTMLButtonElement ||
      active instanceof HTMLSelectElement ||
      active instanceof HTMLAnchorElement;
    if (!interactive) textarea?.focus();
  };

  /**
   * 按顺序应用绑定针对单份权威快照所做的各项决定。
   * 决定本身即 `SpellBinding` 中的状态机。
   */
  function applyBinding(
    snapshot: RoomSnapshot,
    self: Player | undefined,
    reconnected: boolean,
  ): void {
    for (const change of binding.resolve(snapshot, self, reconnected)) apply(change);
  }

  function apply(change: SpellBindingOp): void {
    switch (change.op) {
      case 'armGlyphs':
        glyphs.arm(change.index);
        return;
      case 'resetCast':
        setCast(null, 'idle');
        return;
      case 'clearField':
        setTarget('');
        return;
      case 'endField':
        typing?.endSpell();
        return;
      case 'target':
        setTarget(change.text);
        if (change.artChanged) setArtFailed(false);
        return;
      case 'armAim':
        props.stage?.typing(0, change.element);
        return;
      case 'start':
        typing?.startSpell(change.spell);
        return;
      case 'adopt':
        glyphs.adopt(() => typing?.restoreInput(change.restore, change.mode));
        return;
      case 'cast':
        setCast(change.element, change.hit ? 'done' : 'idle');
        setTip(change.hit ? '施法成功，继续输入下一条咒文。' : '');
        return;
      case 'focus':
        focusInput();
    }
  }

  /** 必须两个渲染器宿主都存在，才通知房间去构建它们。 */
  const notifyHosts = () => {
    if (canvasHost && fxHost) props.onHosts({ canvas: canvasHost, fx: fxHost });
  };

  onMount(() => {
    if (!textarea) return;
    typing = new TypingController(textarea, {
      onCommit: (commit) => props.onCommit(commit),
      onLocalState: (state) => setLocal(state),
      onPasteBlocked: () => {
        setPasteMessage('已阻止粘贴：此输入框不支持粘贴。');
        props.onPasteBlocked();
      },
      onTooLong: () => setPasteMessage('输入过长，已截断到 256 个字符。'),
    });
    notifyHosts();
  });

  onCleanup(() => {
    typing?.destroy();
    typing = null;
  });

  /* ---- 响应式工作 ------------------------------------------------------ */

  createEffect(() => {
    const snapshot = props.snapshot;
    const selfId = props.selfId;
    const marker = props.reconnectedMarker;
    const reconnected = marker !== seenMarker;
    seenMarker = marker;
    const self = snapshot.players.find((player) => player.id === selfId);
    applyBinding(snapshot, self, reconnected);
    if (self) typing?.setLocked(!(snapshot.phase === 'playing' && self.eliminatedAt === null));
  });

  createEffect(
    on(
      local,
      (state) => {
        untrack(() => {
          const snapshot = props.snapshot;
          const element = snapshot.spell?.element ?? null;
          if (state.pending) {
            setCast(element, 'pending');
          } else if (state.progress > 0 && castState() === 'done') {
            // 下一道咒文的第一次击键会清除上一次的施法横幅。
            setCast(element, 'idle');
          } else if (!state.composing && castState() === 'pending') {
            setCast(element, 'idle');
          }
          // 只有已确认且非拼写中的值才会到达渲染器：
          // 舞台的瞄准字形绝不能跟随临时的拼写文本。
          if (!state.composing && snapshot.spell) {
            props.stage?.typing(state.progress, snapshot.spell.element);
          }
          glyphs.emit(state, binding.boundIndex);
        });
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    if (!target()) return;
    // 目标换行会改变效果画布所覆盖的区域，
    // 并占用一行高度，竞技场必须把这行高度还回去。
    glyphs.resize();
  });

  createEffect(() => {
    const value = props.snapshot.phase;
    if (value === lastPhase) return;
    untrack(() => {
      const snapshot = props.snapshot;
      lastPhase = value;
      warnedLastThirty = false;
      if (value === 'countdown') {
        setCast(snapshot.spell?.element ?? null, 'idle');
        setTip('倒数结束后，输入咒文即可施法。');
      } else if (value === 'playing') {
        if (!eliminated() && binding.boundIndex >= 0) {
          focusInput();
          setCast(snapshot.spell?.element ?? null, 'idle');
        }
        setTip('');
      } else if (value === 'finished') {
        setTip('');
      }
    });
  });

  createEffect(() => {
    const ms = remainingMs();
    if (ms === null) return;
    const snapshot = props.snapshot;
    if (snapshot.phase !== 'playing') return;
    const self = selfPlayer();
    const alive = Boolean(self && self.eliminatedAt === null);
    if (ms <= 30_000 && !warnedLastThirty && alive && snapshot.players.length > 1) {
      warnedLastThirty = true;
      setTip('最后 30 秒：截止后存活者按剩余生命排名，稳住输出。');
    }
  });

  return {
    phase,
    self: selfPlayer,
    eliminated,
    finished,
    target,
    targetChars,
    local,
    fieldText: () => textarea?.value ?? props.snapshot.selfInput,
    remainingMs,
    gateRemainingMs,
    castState,
    castElement,
    tip,
    pasteMessage,
    fxState: () => props.fxState,
    artFailed,
    onArtFailed: () => setArtFailed(true),
    glyphs,
    attachTextarea: (el) => {
      textarea = el;
    },
    attachColumn: (el) => {
      column = el;
    },
    attachFxHost: (el) => {
      fxHost = el;
      notifyHosts();
    },
    attachCanvasHost: (el) => {
      canvasHost = el;
      notifyHosts();
    },
  };
}
