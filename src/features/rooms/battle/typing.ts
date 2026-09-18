import { normalizeSpellInput } from '../../../../shared/spell-input';
import { prefixLength } from '../../../ui/format';
import { attachInputGuards, clampInput, countEdit } from './typing-input';

/**
 * The authoritative state of one bound spell identity: which match and spell
 * cursor it belongs to, which draft generation it carries, the exact accepted
 * draft text, and the match-cumulative attempt/error counters as of this draft.
 */
export interface TypingRestore {
  matchId: string;
  /** The player's monotonic, zero-based spell cursor this draft belongs to. */
  spellIndex: number;
  /** The server's draft generation: bumped by every rejection-driven restore. */
  draftEpoch: number;
  draft: string;
  stats: { attemptTotal: number; errorTotal: number };
}

export interface TypingSpellConfig extends TypingRestore {
  target: string;
}

export interface TypingLocalState {
  /** The value that is safe to judge: the confirmed text, never composition. */
  text: string;
  progress: number;
  targetLength: number;
  attempts: number;
  errors: number;
  accuracy: number | null;
  /** Locally finished; the server has not confirmed it yet. */
  pending: boolean;
  /** The spell is settled: dead, deadline passed, or the match ended. */
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
  /** Returns true when the snapshot actually left the client. */
  onCommit(commit: TypingCommit): boolean;
  onLocalState(state: TypingLocalState): void;
  onPasteBlocked(): void;
  onTooLong(): void;
}

/**
 * Owns the spell textarea.
 *
 * Rules it enforces:
 * - an active IME composition is never judged, never sent and never
 *   interrupted: progress and errors are computed from the last confirmed
 *   value, never from provisional composition text;
 * - every confirmed value change is sent immediately (no coalescing), so an
 *   error that is typed and corrected still reaches the server as an attempt;
 * - insertions and replacements count as attempts (retracted errors stay
 *   counted), pure deletions count for nothing;
 * - finishing locally is only a *pending* state. The field stays editable: the
 *   room settles the hit atomically and then advances `spellIndex`, so extra
 *   characters typed after a completion are rejected as stale instead of
 *   dealing a second hit. The authoritative snapshot, never this controller,
 *   decides that a cast happened;
 * - there is exactly one way to adopt server state: `restoreInput` (and the
 *   draft/stats-aware `startSpell`). Both capture the epoch the sends carry;
 *   nothing ever re-reads the epoch from a later snapshot. Adoption rewrites
 *   the field without counting attempts or triggering effects, and never
 *   rolls the epoch backwards: a recovery needs a strictly larger epoch, a
 *   reconnect the same or a larger one;
 * - authoritative state that arrives mid-composition is parked (candidates are
 *   never touched) and applied when the IME settles — before the composition's
 *   own text could be submitted, so a rejected draft can never resurrect.
 */
export class TypingController {
  private target = '';
  private matchId = '';
  private spellIndex = 0;
  /** The draft generation this controller's sends carry. */
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
  /** A spell that arrived mid-composition, applied once the IME settles. */
  private deferredStart: TypingSpellConfig | null = null;
  /** A restore that arrived mid-composition; the newest one wins. */
  private deferredRestore: { restore: TypingRestore; mode: RestoreMode } | null = null;
  /**
   * The composition text an authoritative adoption threw away, and the draft
   * that replaced it. The browser delivers the discarded value again as an
   * `input` after `compositionend`; that event is answered with the accepted
   * draft (no counting, no sending) while any other value is judged normally,
   * so a genuine next keystroke is never swallowed.
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
   * Begin (or restart) a spell: the counters continue from the match-cumulative
   * stats the binding captured, and the field adopts the spell's accepted
   * draft. Per-spell attempt/error history is never reset by an incoming
   * snapshot — only this binding establishes a new baseline.
   *
   * A spell that arrives while the player is mid-composition is deferred: the
   * room advances `spellIndex` the instant a cast is accepted, and clearing the
   * field under an active IME would desynchronise the browser's composition —
   * so the new spell is applied when the composition ends, and the text that
   * belonged to the previous spell is discarded instead of being submitted.
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

  /** Authoritative lock: no further input can be accepted for this match. */
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

  /** The match ended or this player is out: display only, nothing is judged. */
  endSpell(): void {
    this.active = false;
    // A settled match cancels every deferred action: neither a parked spell nor
    // a parked restore may revive input at compositionend.
    this.deferredStart = null;
    this.deferredRestore = null;
    this.staleImeText = null;
    if (this.pendingComplete) {
      this.pendingComplete = false;
      this.emit();
    }
  }

  /**
   * The one authoritative adoption entry. Re-baselines the field on the
   * server's accepted draft and stats: page refreshes, reconnects and
   * rejection-driven recoveries all land here — never by re-sending local
   * edits and never by counting an attempt.
   *
   * Identity comes first: a restore for another match or spell index is
   * ignored (only `startSpell` may switch identity). Epoch comes second: a
   * recovery must carry a strictly larger epoch than the current draft, a
   * reconnect the same or a larger one — anything older is an echo of a draft
   * this controller has already moved past.
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
      // Keep the candidate text and its selection untouched: park the newest
      // authoritative state and stop submitting the old generation's text. The
      // compositionend handler adopts it before any commit could escape.
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

  /** Display-only write: no attempt accounting, no send, lock state untouched. */
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
      // Some browsers refuse selection APIs on hidden fields; typing still works.
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
      // The composition belonged to a spell the room already settled: bind the
      // new identity with its draft and stats, and remember the discarded
      // composition text so the browser's follow-up `input` for the old target
      // falls back to the adopted draft instead of being submitted.
      this.deferredStart = null;
      this.applyStart(start, discarded);
      return;
    }
    const deferred = this.deferredRestore;
    if (deferred) {
      // Authoritative adoption wins over the composition's finished value: the
      // draft was rejected (or re-synchronised) server-side, so adopting it
      // first is what keeps a rejected completion from ever being submitted.
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
      // Provisional composition text is never judged; only re-render the state.
      this.emit();
      return;
    }
    const stale = this.staleImeText;
    if (stale !== null && this.textarea.value === stale.committed) {
      // The browser replayed the discarded composition value: fall back to the
      // accepted draft exactly, keeping lastValue/lastSent so nothing is
      // counted or sent. The flag is spent: a later value that happens to
      // match again is a real keystroke and must be judged.
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

    // Every confirmed change is submitted as it happens: the server's accuracy
    // accounting must see wrong characters even when they are fixed at once.
    this.pushNow();
    this.emit();
  }

  private pushNow(): void {
    // A parked start or restore owns the field's next word: nothing the old
    // generation still holds may reach the server.
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
    // While composing, only the confirmed value may be judged or displayed as
    // progress; provisional candidate text must not create false mistakes.
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
