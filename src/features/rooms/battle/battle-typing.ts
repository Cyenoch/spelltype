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
  /** Bumped only by a real reconnect; the next snapshot then reconciles once. */
  reconnectedMarker: number;
  clock: ServerClock;
  /** Room-level repaint tick: drives the one global clock while a tab is visible. */
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
  /** Exactly what the field holds: the composed value while an IME is open. */
  fieldText(): string;
  remainingMs(): number | null;
  castState(): 'idle' | 'pending' | 'done';
  castElement(): Element | null;
  tip(): string;
  pasteMessage(): string;
  /** The decorative effect layer's own state, shown over the spell glyphs. */
  fxState(): CanvasState;
  artFailed(): boolean;
  onArtFailed(): void;
  /** The characters over the effect canvas and their particle bursts. */
  readonly glyphs: GlyphFeedback;
  attachTextarea(el: HTMLTextAreaElement): void;
  attachColumn(el: HTMLElement): void;
  attachFxHost(el: HTMLElement): void;
  attachCanvasHost(el: HTMLElement): void;
}

/**
 * Owns the combat input station: the field bound to the player's current spell,
 * the cast banner, and the two optional renderer hosts. Every number it exposes
 * comes from the authoritative snapshot or the local field — never from a
 * pending write.
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
    // The room's tick is the repaint heartbeat; reading it here re-evaluates the clock.
    void props.tick;
    const active =
      (snapshot.phase === 'playing' || snapshot.phase === 'countdown') && snapshot.deadline > 0;
    return active ? props.clock.remainingMs(snapshot.deadline) : null;
  });

  const setCast = (element: Element | null, state: 'idle' | 'pending' | 'done') => {
    setCastElement(element);
    setCastState(state);
  };

  /** Focus the field unless the player is already on an interactive control. */
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
   * Applies the binding's decisions for one authoritative snapshot, in order.
   * The decisions themselves are the state machine in `SpellBinding`.
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
        glyphs.adopt(() =>
          change.mode === 'resync'
            ? typing?.resync(change.draft)
            : typing?.restoreDraft(change.draft),
        );
        return;
      case 'cast':
        setCast(change.element, change.hit ? 'done' : 'idle');
        setTip(change.hit ? '施法成功，继续输入下一条咒文。' : '');
        return;
      case 'focus':
        focusInput();
    }
  }

  /** Both renderer hosts must exist before the room is told to build them. */
  const notifyHosts = () => {
    if (canvasHost && fxHost) props.onHosts({ canvas: canvasHost, fx: fxHost });
  };

  onMount(() => {
    if (!textarea) return;
    typing = new TypingController(textarea, {
      onCommit: (commit) => props.onCommit(commit),
      onLocalState: (state) => setLocal(state),
      onPasteBlocked: () => {
        setPasteMessage('已阻止粘贴：咒文必须自己输入，这样伤害才算数。');
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

  /* ---- reactive work --------------------------------------------------- */

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
            setTip('施法中，请稍候…');
          } else if (state.progress > 0 && castState() === 'done') {
            // The first keystroke of the next spell clears the previous cast banner.
            setCast(element, 'idle');
          } else if (!state.composing && castState() === 'pending') {
            setCast(element, 'idle');
          }
          // Only a confirmed, non-composing value reaches the renderer: the
          // stage's aim glyph must never follow provisional composition text.
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
    // A wrapped target changes the box the effect canvas covers, and it costs a
    // line of height that the arena has to give back.
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
      setTip('最后 30 秒：截止后按剩余生命排名，稳住输出。');
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
