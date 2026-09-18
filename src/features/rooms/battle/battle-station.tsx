import { Show, createMemo } from 'solid-js';
import type { Player, RoomSnapshot } from '../../../../shared/protocol';
import { ELEMENT_LABELS, formatAccuracyPercent, percentOf, prefixLength } from '../../../ui/format';
import { elementGlyph, spellIconFor } from '../../../pixi/assets';
import { ELEMENT_CSS } from '../../../ui/elements';
import { ui } from '../../../ui/primitives';
import * as stylex from '@stylexjs/stylex';
import { SpellTypingSurface } from './spell-typing-surface';
import { BattleSelfbar } from './battle-selfbar';
import { styles } from './battle.styles';
import type { BattleTyping } from './battle-typing';

/**
 * The typing station: the recipient's current spell, the one input field bound
 * to it, the cast banner and the viewer's own health and figures. Every number
 * shown here comes from the authoritative snapshot or the local field.
 */
export function BattleStation(props: {
  snapshot: RoomSnapshot;
  selfPlayer: Player | undefined;
  typing: BattleTyping;
}) {
  const targetChars = createMemo(() => props.typing.targetChars());
  const hasSpell = createMemo(() => Boolean(props.snapshot.spell));
  const judgeable = createMemo(
    () =>
      props.typing.phase() === 'playing' && Boolean(props.selfPlayer) && !props.typing.eliminated(),
  );
  /** A phase that does not judge shows the whole target as settled. */
  const settled = createMemo(
    () => props.typing.phase() !== 'playing' && props.typing.target() !== '',
  );

  const statusText = createMemo(() => {
    const self = props.selfPlayer;
    if (settled()) {
      const read = self?.progress ?? prefixLength(props.typing.target(), props.typing.fieldText());
      return `已正确 ${read} / ${targetChars().length} 字 · 本局准确率 ${formatAccuracyPercent(
        self?.accuracy ?? null,
      )}`;
    }
    // Live play separates this spell's progress from the match-cumulative
    // counters. The local state IS the cumulative truth: it was calibrated from
    // the server's stats at bind/reconnect/restore and every edit since is a
    // diff on top — an ordinary ack never stacks onto it.
    const state = props.typing.local();
    const parts: string[] = [];
    if (state.composing) parts.push('输入法组合中，暂不判定');
    parts.push(`本篇已正确 ${state.progress} / ${state.targetLength} 字`);
    parts.push(`本局错误 ${state.errors} 次`);
    parts.push(
      `本局准确率 ${formatAccuracyPercent(
        state.attempts === 0 ? (self?.accuracy ?? null) : state.accuracy,
      )}`,
    );
    return parts.join(' · ');
  });

  /**
   * The input gate's visible state, evaluated on the room's 100 ms tick. A
   * playing snapshot for a living player must carry a gate; when it does not,
   * that is a corrupt state and submitting stays disabled — it is never shown
   * as ordinary waiting.
   */
  const gateView = createMemo(() => {
    if (props.typing.phase() !== 'playing' || props.typing.eliminated()) return null;
    const gate = props.snapshot.selfInputGate;
    if (gate === null) {
      if (!props.snapshot.spell) return null;
      return {
        mode: 'invalid',
        reason: '',
        remaining: null,
        text: '施法状态异常，暂不能施法，请稍后重试。',
      };
    }
    const remaining = props.typing.gateRemainingMs();
    const ready = remaining === null || remaining <= 0;
    const seconds = remaining === null ? null : (remaining / 1000).toFixed(1);
    const text =
      gate.mode === 'enforce'
        ? ready
          ? '已满足施法时间规则'
          : `施法就绪还需 ${seconds} 秒`
        : ready
          ? '观察模式：仅记录施法时间，不限制施法'
          : `观察模式：仅记录施法时间，不限制施法 · 就绪还需 ${seconds} 秒`;
    return { mode: gate.mode, reason: gate.resetReason ?? '', remaining, text };
  });

  const castText = () => {
    const state = props.typing.castState();
    if (state === 'done') {
      const element = props.typing.castElement();
      return `${element ? ELEMENT_LABELS[element] : '咒文'}命中，继续输入下一条咒文。`;
    }
    if (state === 'pending') return '施法中…';
    return props.typing.castElement() ? '开始输入；满足施法时间规则后完成即可施法。' : '等待施法…';
  };

  const meter = createMemo(() => {
    if (!props.snapshot.spell) return { progress: 0, length: 0 };
    if (props.typing.finished()) {
      return { progress: props.selfPlayer?.progress ?? 0, length: targetChars().length };
    }
    return { progress: props.typing.local().progress, length: props.typing.local().targetLength };
  });

  const meterText = () => {
    const { progress, length } = meter();
    return length > 0 ? `${Math.max(0, progress)} / ${length} 字` : '—';
  };

  const spellName = () => {
    if (props.snapshot.spell) return props.snapshot.spell.name;
    return props.typing.eliminated() ? '你已出局 · 不再有咒文' : '咒文尚未显现';
  };

  /** Display-only Chinese meaning of the current spell; empty when no spell is showing. */
  const spellTranslation = createMemo(() => props.snapshot.spell?.translation ?? '');

  const elementLabel = () =>
    props.snapshot.spell ? ELEMENT_LABELS[props.snapshot.spell.element] : '';

  const spellArt = () => {
    const spell = props.snapshot.spell;
    if (!spell) return spellIconFor('arcane', 0);
    return spellIconFor(spell.element, props.selfPlayer?.spellIndex ?? 0);
  };

  const elementColor = () =>
    props.snapshot.spell ? ELEMENT_CSS[props.snapshot.spell.element] : undefined;

  /**
   * What the IME is staging beyond the confirmed prefix. The field itself is
   * invisible, so this chip is the only place provisional composition text
   * shows; the native field stays the accessible copy for assistive tech.
   */
  const composingTail = createMemo(() => {
    const state = props.typing.local();
    if (!state.composing) return '';
    const field = props.typing.fieldText();
    return field.startsWith(state.text) ? field.slice(state.text.length) : field;
  });

  return (
    <div class={stylex.props(styles.station).className}>
      <Show when={props.typing.eliminated()}>
        <div
          class={stylex.props(ui.notice, styles.eliminatedNotice).className}
          data-testid="eliminated-notice"
          data-state="eliminated"
        >
          {`你已被击倒${props.selfPlayer!.rank == null ? '' : `（第 ${props.selfPlayer!.rank} 名）`}。输入已停止，可以观看剩下的战斗——离开或等待结算都不会影响结果。`}
        </div>
      </Show>
      <div class={stylex.props(styles.stationHead).className}>
        <div class={stylex.props(styles.spellHead).className}>
          <span class={stylex.props(styles.spellHeadArt).className}>
            <img
              class={stylex.props(styles.spellArt).className}
              data-testid="spell-art"
              src={spellArt()}
              alt=""
              hidden={props.typing.artFailed()}
              onError={() => props.typing.onArtFailed()}
            />
            <img
              class={stylex.props(styles.spellIcon).className}
              data-testid="spell-element-icon"
              src={elementGlyph(props.snapshot.spell?.element ?? 'arcane')}
              alt={`${elementLabel() || '奥术'}元素`}
              hidden={!props.typing.artFailed()}
            />
          </span>
          <span class={stylex.props(styles.spellName).className} data-testid="spell-name">
            {spellName()}
          </span>
          <span
            class={stylex.props(styles.elementTag).className}
            data-testid="spell-element"
            data-element={props.snapshot.spell?.element ?? ''}
            style={elementColor() ? `color:${elementColor()}` : undefined}
          >
            {elementLabel()}
          </span>
        </div>
        <div class={stylex.props(styles.stationProgress).className}>
          <div
            class={stylex.props(styles.meter, styles.meterSpell).className}
            data-testid="spell-progress"
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={String(percentOf(meter().progress, meter().length))}
            aria-valuetext={meterText()}
            aria-label="当前咒文进度"
          >
            <div
              class={stylex.props(styles.meterFill).className}
              data-testid="spell-progress-fill"
              style={`width:${percentOf(meter().progress, meter().length)}%`}
            />
          </div>
          <span class={stylex.props(styles.meterText).className} data-testid="spell-progress-text">
            {meterText()}
          </span>
        </div>
      </div>

      {/* Combat and practice share the same glyphs, caret and floating native input. */}
      <div class={stylex.props(styles.stationTarget).className}>
        <SpellTypingSurface
          target={props.typing.target()}
          text={props.typing.local().text}
          settled={settled()}
          completed={props.typing.castState() === 'done'}
          composing={props.typing.local().composing}
          element={props.snapshot.spell?.element ?? null}
          compact={props.typing.glyphs.longTarget()}
          hidden={!hasSpell()}
          attachColumn={(el) => props.typing.attachColumn(el)}
          input={{
            id: 'typing-input',
            'data-testid': 'typing-input',
            'aria-label': '咒文输入区',
            'aria-describedby': 'input-status',
            ref: (el) => props.typing.attachTextarea(el),
            get hidden() {
              return props.typing.finished();
            },
            get readOnly() {
              return !judgeable();
            },
          }}
        />
        {/* The Chinese meaning is display-only metadata: it lives outside the typed target
            (spell-text) and outside the input path, so it can never join the English text that
            drives judging, damage or progress, and it never touches the IME or caret. */}
        <Show when={spellTranslation() !== ''}>
          <p
            class={stylex.props(styles.spellTranslation).className}
            data-testid="spell-translation"
          >
            {spellTranslation()}
          </p>
        </Show>
        {/* Decorative particle layer over the spell glyphs: absolutely
            positioned, ignores pointer events, and keeps the real text
            underneath untouched and readable by the DOM and assistive tech. */}
        <div
          class={
            stylex.props(
              styles.targetFx,
              props.typing.fxState() === 'failed' && styles.targetFxFailed,
            ).className
          }
          data-testid="typing-fx"
          data-state={props.typing.fxState()}
          aria-hidden="true"
          ref={(el) => {
            props.typing.attachFxHost(el);
          }}
        />
      </div>

      <div class={stylex.props(styles.typeArea).className} hidden={props.typing.finished()}>
        <Show when={gateView()}>
          {(view) => (
            <div
              class={
                stylex.props(styles.inputGate, view().mode === 'invalid' && styles.inputGateAlert)
                  .className
              }
              data-testid="input-gate"
              data-mode={view().mode}
              data-ready-remaining-ms={view().remaining === null ? '' : String(view().remaining)}
              data-reason={view().reason}
            >
              <span class={stylex.props(styles.inputGateText).className}>{view().text}</span>
              {/* The rejection explanation lives here — not in the countdown —
                  so the polite announcement fires once per state change while
                  the per-tick remaining time stays silent to screen readers. */}
              <Show when={view().reason === 'completion_too_early'}>
                <span
                  class={stylex.props(styles.inputGateReason).className}
                  data-testid="input-gate-reason"
                  aria-live="polite"
                >
                  输入完成早于本局施法规则，已恢复上一次接受的输入；就绪后请重新补全。
                </span>
              </Show>
            </div>
          )}
        </Show>
        <div
          class={stylex.props(styles.inputStatus).className}
          id="input-status"
          data-testid="input-status"
        >
          {statusText()}
        </div>
        {/* The field is invisible, so a live IME composition would be hidden raw
            text: this chip mirrors what is staged but not yet judged. Visual
            only — the native field remains the accessible input. */}
        <Show when={props.typing.local().composing}>
          <div
            class={stylex.props(styles.composingChip).className}
            data-testid="composing-text"
            aria-hidden="true"
          >
            {`组合中：${composingTail() === '' ? '…' : composingTail()}`}
          </div>
        </Show>
        <div
          class={
            stylex.props(
              styles.pasteNotice,
              props.typing.pasteMessage() === '' && styles.pasteNoticeEmpty,
            ).className
          }
          data-testid="paste-notice"
          aria-live="polite"
        >
          {props.typing.pasteMessage()}
        </div>
        <div class={stylex.props(styles.typeAreaRow).className}>
          <div
            class={
              stylex.props(
                styles.castFeedback,
                props.typing.castState() === 'idle' && styles.castFeedbackIdle,
                props.typing.castState() === 'pending' && styles.castFeedbackPending,
              ).className
            }
            data-testid="cast-feedback"
            data-state={props.typing.castState()}
            data-element={props.typing.castElement() ?? ''}
            aria-live="polite"
          >
            {castText()}
          </div>
          <Show when={!props.typing.eliminated()}>
            <p
              class={stylex.props(ui.smallText, styles.typeHint).className}
              data-testid="typing-hint"
            >
              点击咒文即可直接输入，退格可改正。
            </p>
          </Show>
          <p
            class={stylex.props(ui.smallText, styles.tip).className}
            data-testid="battle-tip"
            aria-live="polite"
          >
            {props.typing.tip()}
          </p>
        </div>
      </div>

      <BattleSelfbar self={props.selfPlayer} />
    </div>
  );
}
