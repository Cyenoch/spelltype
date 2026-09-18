import { Index, Show, createMemo } from 'solid-js';
import type { Player, RoomSnapshot } from '../../../../shared/protocol';
import { ELEMENT_LABELS, formatAccuracyPercent, percentOf, prefixLength } from '../../../ui/format';
import { elementGlyph, spellIconFor } from '../../../pixi/assets';
import { ELEMENT_CSS } from '../../../ui/elements';
import { ui } from '../../../ui/primitives';
import * as stylex from '@stylexjs/stylex';
import { charHook, charTitle, charTones } from './battle-glyphs';
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

  /** Where the judged prefix ends: a settled phase shows the whole target as read. */
  const matched = createMemo(() =>
    settled()
      ? targetChars().length
      : prefixLength(props.typing.target(), props.typing.local().text),
  );

  const tones = createMemo(() =>
    charTones(targetChars(), props.typing.local().text, matched(), settled()),
  );

  const statusText = createMemo(() => {
    const self = props.selfPlayer;
    if (settled()) {
      const read = self?.progress ?? prefixLength(props.typing.target(), props.typing.fieldText());
      return [
        `已正确 ${read} / ${targetChars().length} 字`,
        `准确率 ${formatAccuracyPercent(self?.accuracy ?? null)}`,
      ].join(' · ');
    }
    const state = props.typing.local();
    const parts: string[] = [];
    if (state.composing) parts.push('输入法组合中，暂不判定');
    parts.push(`已正确 ${state.progress} / ${state.targetLength} 字`);
    if (state.errors > 0) parts.push(`错误 ${state.errors} 次`);
    parts.push(
      `准确率 ${formatAccuracyPercent(state.attempts === 0 ? (self?.accuracy ?? null) : state.accuracy)}`,
    );
    return parts.join(' · ');
  });

  const castText = () => {
    const state = props.typing.castState();
    if (state === 'done') {
      const element = props.typing.castElement();
      return `${element ? ELEMENT_LABELS[element] : '咒文'}命中，下一条咒文已就绪。`;
    }
    if (state === 'pending') return '施法中…';
    return props.typing.castElement() ? '开始输入，完成后立刻施法。' : '等待施法…';
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

  const elementLabel = () =>
    props.snapshot.spell ? ELEMENT_LABELS[props.snapshot.spell.element] : '';

  const spellArt = () => {
    const spell = props.snapshot.spell;
    if (!spell) return spellIconFor('arcane', 0);
    return spellIconFor(spell.element, props.selfPlayer?.spellIndex ?? 0);
  };

  const elementColor = () =>
    props.snapshot.spell ? ELEMENT_CSS[props.snapshot.spell.element] : undefined;

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

      <div class={stylex.props(styles.stationTarget).className}>
        <div
          class={
            stylex.props(
              styles.spellText,
              props.typing.glyphs.longTarget() && styles.spellTextCompact,
            ).className
          }
          data-testid="spell-text"
          hidden={!hasSpell()}
        >
          <span class={stylex.props(ui.srOnly).className} data-testid="spell-text-plain">
            {`目标咒文：${props.typing.target()}`}
          </span>
          <span
            aria-hidden="true"
            ref={(el) => {
              props.typing.attachColumn(el);
            }}
          >
            <Index each={targetChars()}>
              {(char, index) => (
                <span
                  class={`${
                    stylex.props(
                      styles.ch,
                      tones()[index] === 'done' && styles.chDone,
                      tones()[index] === 'ok' && styles.chOk,
                      tones()[index] === 'cur' && styles.chCur,
                      tones()[index] === 'err' && styles.chErr,
                    ).className
                  } ${charHook(tones()[index])}`}
                  title={charTitle(tones()[index], index, targetChars()[index])}
                >
                  {char()}
                </span>
              )}
            </Index>
          </span>
        </div>
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
        <label class={stylex.props(ui.srOnly).className} for="typing-input">
          咒文输入区
        </label>
        <textarea
          id="typing-input"
          data-testid="typing-input"
          class={
            stylex.props(styles.typeField, judgeable() ? null : styles.typeFieldLocked).className
          }
          rows={2}
          spellcheck={false}
          autocomplete="off"
          autocorrect="off"
          autocapitalize="off"
          aria-describedby="input-status"
          aria-label="咒文输入区"
          ref={(el) => {
            props.typing.attachTextarea(el);
          }}
          hidden={props.typing.finished()}
          readOnly={!judgeable()}
        />
        <div
          class={stylex.props(styles.inputStatus).className}
          id="input-status"
          data-testid="input-status"
        >
          {statusText()}
        </div>
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
