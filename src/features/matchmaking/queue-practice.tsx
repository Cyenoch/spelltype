import * as stylex from '@stylexjs/stylex';
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import corpusRaw from './practice-spells.txt?raw';
import { normalizeSpellInput } from '../../../shared/spell-input';
import { attachInputGuards, clampInput, countEdit } from '../rooms/battle/typing-input';
import { formatAccuracyPercent, formatAmount, formatDuration } from '../../ui/format';
import { ui } from '../../ui/primitives';
import { styles } from './queue-practice.styles';
import { SpellTypingSurface } from '../rooms/battle/spell-typing-surface';
import { styles as battleStyles } from '../rooms/battle/battle.styles';
import type { TypingEffects } from '../../pixi/typing-effects';
import { motion } from '../../ui/motion';
import { createGlyphStamp } from '../rooms/battle/glyph-stamp';

/** The live clock repaints WPM/elapsed at the same cadence as the queue clock. */
const TICK_INTERVAL_MS = 250;

/** One complete spell per line, in corpus order; parsing never throws. */
const SPELLS: readonly string[] = corpusRaw
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

/** Fisher–Yates over every index, so one full pass visits the corpus exactly once. */
function shuffledIndices(): number[] {
  const order = SPELLS.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * A fresh deck whose first entry never equals `previousLast`, so cycling the
 * corpus cannot immediately repeat the sentence just practised.
 */
function nextDeck(previousLast: number): number[] {
  const order = shuffledIndices();
  if (order.length > 1 && order[0] === previousLast) {
    [order[0], order[1]] = [order[1], order[0]];
  }
  return order;
}

/**
 * Local spell-typing practice for the matchmaking wait.
 *
 * Everything lives in this mounted panel: no API, storage or ranking. Typing
 * semantics are the battle's, reused verbatim — `countEdit` charges insertions
 * as attempts and wrong ones as errors (a retracted mistake stays counted, a
 * pure deletion costs nothing), `normalizeSpellInput` accepts full-width
 * punctuation as the target's exact character, and `attachInputGuards` refuses
 * paste, drop and Enter. IME composition is never judged; its settled value
 * commits exactly once. Input that arrives after the queue settled — including
 * a late composition end — is ignored and the field restored to the judged
 * draft, so a requeue resumes the very same sentence with no inactive time
 * counted.
 *
 * The clock begins on the first confirmed insertion, pauses on blur and on a
 * hidden document, stops on completion and while the queue is inactive, and
 * resumes only with an active queue plus input focus. The interval exists only
 * while the clock runs, so keystrokes never recreate it.
 */
export function QueuePractice(props: { active: boolean }) {
  const stampGlyph = createGlyphStamp();
  let textarea: HTMLTextAreaElement | undefined;
  let glyphColumn: HTMLSpanElement | undefined;
  let fxHost!: HTMLDivElement;
  let effects: TypingEffects | null = null;
  let disposed = false;
  const [fxState, setFxState] = createSignal('loading');
  onMount(() => {
    void import('../../pixi/typing-effects')
      .then(({ createTypingEffects }) => createTypingEffects(fxHost))
      .then((layer) => {
        if (disposed) {
          layer.destroy();
          return;
        }
        effects = layer;
        setFxState('ready');
      })
      .catch(() => {
        if (!disposed) setFxState('failed');
      });
  });
  /** The judged draft — confirmed text only, never provisional composition. */
  let lastValue = '';
  /** Clock state outside reactivity: mutation sites call `syncClock` themselves. */
  let clockArmed = false;
  let needsInsertion = true;
  let startedAt = 0;
  let detachGuards: () => void = () => undefined;

  const [deck, setDeck] = createSignal(shuffledIndices());
  const [deckPos, setDeckPos] = createSignal(0);
  const [draft, setDraft] = createSignal('');
  const [attempts, setAttempts] = createSignal(0);
  const [errors, setErrors] = createSignal(0);
  const [completedCount, setCompletedCount] = createSignal(0);
  const [completed, setCompleted] = createSignal(false);
  const [composing, setComposing] = createSignal(false);
  const [fieldText, setFieldText] = createSignal('');
  let discardComposition = false;
  const [focused, setFocused] = createSignal(false);
  const [pageHidden, setPageHidden] = createSignal(document.hidden);
  const [refusal, setRefusal] = createSignal<string | null>(null);
  const [running, setRunning] = createSignal(false);
  const [accumulated, setAccumulated] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());

  const target = createMemo(() => SPELLS[deck()[deckPos()]]);

  const elapsedMs = () => accumulated() + (running() ? Math.max(0, now() - startedAt) : 0);

  /** Correct insertions per five characters per active minute. */
  const wpm = createMemo(() => {
    const ms = elapsedMs();
    if (ms <= 0) return null;
    return Math.max(0, attempts() - errors()) / 5 / (ms / 60_000);
  });

  /** Every wrong inserted character over every attempt, corrections included. */
  const errorRate = createMemo(() => (attempts() === 0 ? null : errors() / attempts()));

  const statusMessage = createMemo(() => {
    if (!props.active) return '匹配已结束，练习暂停；重新排队并点击咒文即可继续。';
    if (completed()) return '完成！按 Enter 或点击下一句继续。';
    return refusal() ?? '点击咒文直接输入，退格可改正；全角标点自动等效。';
  });

  const statusTone = createMemo(() => {
    if (!props.active) return 'muted';
    if (completed()) return 'done';
    return refusal() ? 'error' : 'muted';
  });

  const syncClock = () => {
    const want =
      clockArmed && !needsInsertion && !completed() && props.active && focused() && !pageHidden();
    if (want === running()) return;
    if (want) {
      startedAt = Date.now();
      setNow(startedAt);
      setRunning(true);
      return;
    }
    setAccumulated((total) => total + Math.max(0, Date.now() - startedAt));
    setRunning(false);
  };

  // The interval exists exactly while the clock runs — never per keystroke.
  createEffect(() => {
    if (!running()) return;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    onCleanup(() => window.clearInterval(timer));
  });

  // Reactive clock inputs; plain-variable sites call `syncClock` directly.
  createEffect(() => {
    void props.active;
    void completed();
    void focused();
    void pageHidden();
    syncClock();
  });

  // Settling the queue freezes the clock, drops focus and retracts whatever an
  // aborted IME composition may have left in the disabled field.
  createEffect(() => {
    if (props.active) {
      syncClock();
      return;
    }
    setFocused(false);
    if (composing()) discardComposition = true;
    setComposing(false);
    if (textarea) textarea.value = lastValue;
    setFieldText(lastValue);
    syncClock();
  });

  const handleVisibility = () => {
    setPageHidden(document.hidden);
    syncClock();
  };
  document.addEventListener('visibilitychange', handleVisibility);
  onCleanup(() => document.removeEventListener('visibilitychange', handleVisibility));

  const handleFocus = () => {
    setFocused(true);
    syncClock();
  };
  const handleBlur = () => {
    setFocused(false);
    syncClock();
  };
  const handleCompositionStart = () => {
    discardComposition = !props.active;
    setComposing(props.active);
  };
  const handleCompositionEnd = () => {
    setComposing(false);
    if (!props.active || discardComposition) {
      discardComposition = false;
      if (textarea) textarea.value = lastValue;
      setFieldText(lastValue);
      return;
    }
    // Commit once: the settled value is judged exactly like a plain input.
    if (textarea) judge(textarea.value);
  };
  const handleInput = (event: Event) => {
    if (textarea) setFieldText(textarea.value);
    if (composing() || (event instanceof InputEvent && event.isComposing)) return;
    if (textarea) judge(textarea.value);
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.isComposing || composing()) return;
    event.preventDefault();
    if (!props.active || event.repeat) return;
    if (completed()) advanceSentence();
    else setRefusal('完成当前咒文后，按 Enter 继续下一句。');
  };

  /**
   * The one judged entry, mirroring the battle controller: clamp, normalise,
   * diff against the previous confirmed value, then account the edit.
   */
  const judge = (rawValue: string) => {
    if (!props.active || completed()) return;
    const spell = target();
    const clamped = clampInput(rawValue);
    const next = normalizeSpellInput(clamped.text, spell);
    if (next !== rawValue && textarea) {
      const { selectionStart, selectionEnd, selectionDirection } = textarea;
      textarea.value = next;
      textarea.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
    }
    if (clamped.truncated) setRefusal('输入超出长度上限，已截断。');
    if (next === lastValue) return;
    const previous = lastValue;
    lastValue = next;
    setDraft(next);
    setFieldText(next);
    const edit = countEdit(previous, next, spell);
    if (edit.inserted > 0) {
      setAttempts((total) => total + edit.inserted);
      if (edit.errors > 0) setErrors((total) => total + edit.errors);
      setRefusal(null);
      clockArmed = true;
      needsInsertion = false;
      syncClock();
      if (glyphColumn && !pageHidden() && !motion.reduced) {
        const before = Array.from(previous);
        const after = Array.from(next);
        let start = 0;
        while (start < before.length && start < after.length && before[start] === after[start])
          start += 1;
        const hostBox = fxHost.getBoundingClientRect();
        for (let index = start; index < start + edit.inserted; index += 1) {
          const glyph =
            index < spell.length
              ? glyphColumn.children[index]
              : glyphColumn.lastElementChild?.children[index - spell.length];
          if (!(glyph instanceof HTMLElement)) continue;
          const box = glyph.getBoundingClientRect();
          effects?.emit(
            box.left - hostBox.left + box.width / 2,
            box.top - hostBox.top + box.height / 2,
            'arcane',
            after[index] !== spell[index],
          );
          if (after[index] === spell[index]) stampGlyph(glyph);
        }
      }
    }
    if (spell !== '' && next === spell) {
      // Exact match marks completed exactly once: further input is ignored above.
      needsInsertion = true;
      setCompleted(true);
      setCompletedCount((total) => total + 1);
      syncClock();
    }
  };

  const clearField = () => {
    lastValue = '';
    setDraft('');
    setFieldText('');
    setCompleted(false);
    if (textarea && textarea.value !== '') textarea.value = '';
  };

  /** 下一句 and 换一句 share one path: no immediate repeat, corpus-wide coverage. */
  const advanceSentence = () => {
    if (!props.active || composing()) return;
    needsInsertion = true;
    syncClock();
    clearField();
    const pos = deckPos() + 1;
    if (pos >= deck().length) {
      setDeck(nextDeck(deck()[deckPos()]));
      setDeckPos(0);
    } else {
      setDeckPos(pos);
    }
    setRefusal(null);
    syncClock();
    textarea?.focus();
  };

  const resetPractice = () => {
    if (!props.active || composing()) return;
    clearField();
    setDeck(nextDeck(deck()[deckPos()]));
    setDeckPos(0);
    clockArmed = false;
    needsInsertion = true;
    startedAt = 0;
    setAttempts(0);
    setErrors(0);
    setCompletedCount(0);
    setAccumulated(0);
    setRunning(false);
    setNow(Date.now());
    setRefusal(null);
    syncClock();
    textarea?.focus();
  };

  onCleanup(() => {
    disposed = true;
    effects?.destroy();
    detachGuards();
    if (!textarea) return;
    textarea.removeEventListener('input', handleInput);
    textarea.removeEventListener('compositionstart', handleCompositionStart);
    textarea.removeEventListener('compositionend', handleCompositionEnd);
    textarea.removeEventListener('focus', handleFocus);
    textarea.removeEventListener('blur', handleBlur);
    textarea.removeEventListener('keydown', handleKeyDown);
  });

  return (
    <section
      class={stylex.props(ui.panel, styles.root).className}
      data-testid="queue-practice"
      data-state={!props.active ? 'inactive' : completed() ? 'done' : 'typing'}
      aria-label="排队等待打字练习"
    >
      <div class={stylex.props(ui.panelHead, styles.head).className}>
        <div class={stylex.props(styles.titleGroup).className}>
          <h2 class={stylex.props(ui.title, styles.heading).className}>排队练习</h2>
          <span class={stylex.props(ui.eyebrow).className}>{SPELLS.length} 条咒文</span>
        </div>
      </div>
      <div class={stylex.props(battleStyles.stationTarget).className}>
        <SpellTypingSurface
          target={target()}
          text={draft()}
          settled={completed()}
          completed={completed()}
          composing={composing()}
          element="arcane"
          testId="practice-target"
          attachColumn={(el) => {
            glyphColumn = el;
          }}
          input={{
            id: 'practice-input',
            'data-testid': 'practice-input',
            'aria-label': '练习咒文输入区',
            'aria-describedby': 'practice-status',
            get disabled() {
              return !props.active;
            },
            get readOnly() {
              return completed();
            },
            ref: (el) => {
              textarea = el;
              el.addEventListener('input', handleInput);
              el.addEventListener('compositionstart', handleCompositionStart);
              el.addEventListener('compositionend', handleCompositionEnd);
              el.addEventListener('focus', handleFocus);
              el.addEventListener('blur', handleBlur);
              el.addEventListener('keydown', handleKeyDown);
              detachGuards = attachInputGuards(el, {
                onRefused: () => setRefusal('已拒绝粘贴与拖入：练习需要逐字输入。'),
                isComposing: composing,
              });
            },
          }}
        />
        <div
          ref={(el) => {
            fxHost = el;
          }}
          class={
            stylex.props(
              battleStyles.targetFx,
              fxState() === 'failed' && battleStyles.targetFxFailed,
            ).className
          }
          data-testid="practice-typing-fx"
          data-state={fxState()}
          aria-hidden="true"
        />
      </div>
      <Show when={composing()}>
        <div class={stylex.props(battleStyles.composingChip).className} aria-hidden="true">
          组合中：
          {fieldText().startsWith(draft()) ? fieldText().slice(draft().length) || '…' : fieldText()}
        </div>
      </Show>
      <p
        id="practice-status"
        class={
          stylex.props(
            styles.statusLine,
            statusTone() === 'done' && styles.statusDone,
            statusTone() === 'error' && styles.statusError,
          ).className
        }
        data-testid="practice-status"
        data-tone={statusTone()}
        role="status"
      >
        {statusMessage()}
      </p>
      <div class={stylex.props(ui.statTiles, styles.tiles).className}>
        <div class={stylex.props(ui.tile).className}>
          <div class={stylex.props(ui.tileLabel).className}>速度（WPM）</div>
          <div
            class={stylex.props(ui.tileValue, styles.tileValueCompact).className}
            data-testid="practice-wpm"
          >
            {wpm() === null ? '—' : formatAmount(wpm()!)}
          </div>
        </div>
        <div class={stylex.props(ui.tile).className}>
          <div class={stylex.props(ui.tileLabel).className}>错误率</div>
          <div
            class={stylex.props(ui.tileValue, styles.tileValueCompact).className}
            data-testid="practice-error-rate"
          >
            {formatAccuracyPercent(errorRate())}
          </div>
        </div>
        <div class={stylex.props(ui.tile).className}>
          <div class={stylex.props(ui.tileLabel).className}>已完成</div>
          <div
            class={stylex.props(ui.tileValue, styles.tileValueCompact).className}
            data-testid="practice-completed"
          >
            {`${completedCount()} 句`}
          </div>
        </div>
        <div class={stylex.props(ui.tile).className}>
          <div class={stylex.props(ui.tileLabel).className}>练习用时</div>
          <div
            class={stylex.props(ui.tileValue, styles.tileValueCompact).className}
            data-testid="practice-elapsed"
          >
            {formatDuration(elapsedMs())}
          </div>
        </div>
      </div>
      <div class={stylex.props(ui.buttonRow).className}>
        <button
          type="button"
          class={stylex.props(ui.button, ui.primary, ui.small).className}
          data-testid="practice-next"
          disabled={!props.active || !completed() || composing()}
          onClick={advanceSentence}
        >
          下一句 · Enter
        </button>
        <button
          type="button"
          class={stylex.props(ui.button, ui.ghost, ui.small).className}
          data-testid="practice-skip"
          disabled={!props.active || composing()}
          onClick={advanceSentence}
        >
          换一句
        </button>
        <button
          type="button"
          class={stylex.props(ui.button, ui.ghost, ui.small).className}
          data-testid="practice-reset"
          disabled={!props.active || composing()}
          onClick={resetPractice}
        >
          重置练习
        </button>
      </div>
      <p class={stylex.props(ui.hint).className}>
        每 5 个正确输入字符计 1
        词；错误率保留改错记录。离开输入区或切到后台暂停计时，练习不影响匹配与战绩。
      </p>
    </section>
  );
}
