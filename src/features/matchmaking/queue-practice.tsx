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

/** 实时时钟以与排队时钟相同的节奏刷新 WPM 与已用时间。 */
const TICK_INTERVAL_MS = 250;

/** 每行一条完整咒文，按语料库顺序排列；解析过程绝不抛出异常。 */
const SPELLS: readonly string[] = corpusRaw
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

/** 对所有索引执行 Fisher-Yates 洗牌算法，确保一轮遍历精确覆盖语料库一次。 */
function shuffledIndices(): number[] {
  const order = SPELLS.map((_, index) => index);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * 生成新的一轮咒文卡组，其第一条绝不等于上一轮的最后一条（`previousLast`），
 * 避免在新旧轮次衔接时立即重复刚才练习过的句子。
 */
function nextDeck(previousLast: number): number[] {
  const order = shuffledIndices();
  if (order.length > 1 && order[0] === previousLast) {
    [order[0], order[1]] = [order[1], order[0]];
  }
  return order;
}

/**
 * 匹配等待期间的本地咒文打字练习面板。
 *
 * 所有状态均保存在本挂载组件中：无 API 调用、无本地持久化存储、无天梯排行。
 * 打字判定语义完全复用对局逻辑：`countEdit` 将键入计入尝试次数，错字计入错误次数
 * （撤回的错误输入仍会被计入，纯删除操作不消耗次数），`normalizeSpellInput`
 * 允许全角标点对齐匹配目标字符，`attachInputGuards` 拦截粘贴、拖放及 Enter 换行。
 * 输入法（IME）组字过程不参与判定；组字完成确认（compositionend）后仅提交裁决一次。
 * 在排队结束后到达的输入（包括延迟触发的 IME 组字结束）会被忽略，
 * 且输入框会还原为已判定的草稿内容，以便重新排队时能够无缝继续练习同一句话，且不计入未操作的等待时间。
 *
 * 计时器在首次确认输入字符时启动，在输入框失焦或页面隐藏时暂停，
 * 在句子完成或队列不活跃时停止，仅在队列处于排队中且输入框获焦时恢复计时。
 * 循环定时器仅在时钟运转期间存在，按键过程不会重复创建定时器。
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
  /** 已判定的草稿——仅包含已确认的文本，绝不包含临时的输入法组字文本。 */
  let lastValue = '';
  /** 响应式体系之外的时钟状态：修改时由调用点自行调用 `syncClock` 同步。 */
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

  /** 活跃时间内每分钟打字速度（每 5 个正确输入字符折算为 1 个词，WPM）。 */
  const wpm = createMemo(() => {
    const ms = elapsedMs();
    if (ms <= 0) return null;
    return Math.max(0, attempts() - errors()) / 5 / (ms / 60_000);
  });

  /** 所有尝试中输入错误的字符比例（包含后续修改更正的错误）。 */
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

  // 定时器仅在时钟运转期间存在——绝不在每次按键时重复创建。
  createEffect(() => {
    if (!running()) return;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    onCleanup(() => window.clearInterval(timer));
  });

  // 响应式时钟输入项；普通变量变更处由调用点直接调用 `syncClock`。
  createEffect(() => {
    void props.active;
    void completed();
    void focused();
    void pageHidden();
    syncClock();
  });

  // 排队结算时会冻结时钟、释放输入框焦点，并撤回禁用的输入框中可能残留的未完成 IME 组字内容。
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
    // 仅提交一次：组字结算后的值与普通直接输入的判定规则完全相同。
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
   * 唯一的输入判定入口，与对局控制器逻辑一致：限制长度、字符归一化、
   * 计算与上一次已确认文本的差异，进而统计编辑动作。
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
      // 完全匹配即标记完成（仅触发一次）：后续多余输入会被上方逻辑忽略。
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

  /** “下一句”与“换一句”共用同一逻辑：避免立即重复，确保覆盖整个语料库。 */
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
