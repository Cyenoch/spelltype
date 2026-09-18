import { normalizeSpellInput } from '../../../../shared/spell-input';
import { prefixLength } from '../../../ui/format';
import { attachInputGuards, clampInput, countEdit } from './typing-input';

export interface TypingSpellConfig {
  matchId: string;
  /** The player's monotonic, zero-based spell cursor this target belongs to. */
  spellIndex: number;
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
  text: string;
  complete: boolean;
  progress: number;
}

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
 * - reconnecting adopts the server's accepted draft and drops input the server
 *   never accepted (no retroactive submission after a reconnect).
 */
export class TypingController {
  private target = '';
  private matchId = '';
  private spellIndex = 0;
  private active = false;
  private composing = false;
  private lastValue = '';
  private lastSent: string | null = null;
  private attempts = 0;
  private errors = 0;
  private pendingComplete = false;
  private locked = false;
  private lastPushDelivered = true;
  private deferredResync: string | null = null;
  /** A spell that arrived mid-composition, applied once the IME settles. */
  private deferredStart: TypingSpellConfig | null = null;
  /**
   * The text the IME committed for a spell the room already settled. The browser
   * delivers that text as an `input` after `compositionend`; it is discarded by
   * value, so a genuine next keystroke is never swallowed.
   */
  private staleImeText: string | null = null;

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
   * Begin (or restart) a spell: counters reset, the field is cleared. Per-spell
   * attempt/error history is dropped only here, never by an incoming snapshot.
   *
   * A spell that arrives while the player is mid-composition is deferred: the
   * room advances `spellIndex` the instant a cast is accepted, and clearing the
   * field under an active IME would desynchronise the browser's composition —
   * so the new spell is applied when the composition ends, and the text that
   * belonged to the previous spell is dropped instead of being submitted.
   */
  startSpell(config: TypingSpellConfig): void {
    if (this.composing) {
      this.deferredStart = config;
      return;
    }
    this.applyStart(config, null);
  }

  private applyStart(config: TypingSpellConfig, staleImeText: string | null): void {
    this.staleImeText = staleImeText;
    this.target = config.target;
    this.matchId = config.matchId;
    this.spellIndex = config.spellIndex;
    this.active = true;
    this.attempts = 0;
    this.errors = 0;
    this.pendingComplete = false;
    this.locked = false;
    this.lastSent = null;
    this.deferredResync = null;
    this.lastValue = '';
    if (this.textarea.value !== '') this.textarea.value = '';
    this.emit();
  }

  /** Authoritative lock: no further input can be accepted for this match. */
  setLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    this.emit();
  }

  /** The match ended or this player is out: display only, nothing is judged. */
  endSpell(): void {
    this.active = false;
    // A deferred spell must not revive a match that has already settled.
    this.deferredStart = null;
    this.staleImeText = null;
    if (this.pendingComplete) {
      this.pendingComplete = false;
      this.emit();
    }
  }

  /**
   * Reconnect reconciliation: adopt exactly what the server accepted. Local
   * edits made while the socket was down were never submitted, so they are
   * dropped rather than replayed. A composition in flight is never touched —
   * the adoption is deferred until the composition is confirmed.
   */
  resync(draft: string): void {
    if (!this.active) return;
    if (this.locked) {
      // Already settled: only display what the server accepted.
      this.restoreDraft(draft);
      return;
    }
    if (this.composing) {
      this.deferredResync = draft;
      return;
    }
    this.adoptServerDraft(draft);
  }

  /**
   * Restore a server-accepted draft (page refresh, first snapshot). A locked
   * spell only displays the accepted text; an open spell adopts it when the
   * server is at least as far as the local field.
   */
  restoreDraft(draft: string): void {
    // While a deferred spell is pending the field still belongs to the previous
    // one, so an accepted draft for the new spell is adopted after it binds.
    if (this.composing || this.deferredStart !== null || draft === '') return;
    const local = this.textarea.value;
    if (local === draft) return;
    if (this.locked) {
      this.showAccepted(draft);
      return;
    }
    const serverAhead = draft.length > local.length && draft.startsWith(local);
    if (local.length > 0 && !serverAhead) return;
    this.adoptServerDraft(draft);
  }

  private adoptServerDraft(draft: string): void {
    this.deferredResync = null;
    this.pendingComplete = false;
    this.showAccepted(draft);
  }

  /** Display-only write: no attempt accounting, lock state untouched. */
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
    const deferred = this.deferredStart;
    if (deferred) {
      // The composition belonged to the spell the room already settled: bind the
      // new one, and remember the committed text so the browser's follow-up
      // `input` for the old target is dropped instead of being submitted.
      this.deferredStart = null;
      const committed = this.textarea.value;
      this.applyStart(deferred, committed === '' ? null : committed);
      return;
    }
    this.commitValue(this.textarea.value);
    if (this.deferredResync === null) return;
    // The composition was committed but never submitted: keep it only when the
    // socket actually took it, otherwise fall back to the accepted state.
    if (!this.lastPushDelivered) {
      const draft = this.deferredResync;
      this.deferredResync = null;
      this.adoptServerDraft(draft);
    } else {
      this.deferredResync = null;
    }
  };

  private readonly handleInput = (event: Event): void => {
    const composing = this.composing || (event instanceof InputEvent && event.isComposing === true);
    if (composing) {
      // Provisional composition text is never judged; only re-render the state.
      this.emit();
      return;
    }
    if (this.staleImeText !== null && this.textarea.value === this.staleImeText) {
      this.staleImeText = null;
      this.textarea.value = '';
      this.lastValue = '';
      this.lastSent = '';
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
    if (this.composing || !this.active) return;
    const text = this.textarea.value;
    if (text === this.lastSent) {
      this.lastPushDelivered = true;
      return;
    }
    this.lastSent = text;
    this.lastPushDelivered = this.callbacks.onCommit({
      matchId: this.matchId,
      spellIndex: this.spellIndex,
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
