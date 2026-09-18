import { createMemo } from 'solid-js';
import type { Player } from '../../../../shared/protocol';
import { formatAmount, formatHealth, percentOf } from '../../../ui/format';
import { ui } from '../../../ui/primitives';
import * as stylex from '@stylexjs/stylex';
import { styles } from './battle.styles';
import { CRITICAL_HP_RATIO, LOW_HP_RATIO, type RenderMode } from './battle-view';

interface HpTone {
  /** Threshold bucket shared by the arena vignette and the health bar. */
  ratio: 'ok' | 'low' | 'critical' | 'down';
  percent: number;
  text: string;
}

function hpTone(hp: number, maxHp: number, eliminated: boolean): HpTone {
  const clamped = Math.max(0, hp);
  const percent = percentOf(clamped, maxHp);
  const ratio = eliminated
    ? 'down'
    : percent <= CRITICAL_HP_RATIO * 100
      ? 'critical'
      : percent <= LOW_HP_RATIO * 100
        ? 'low'
        : 'ok';
  return { ratio, percent, text: formatHealth(clamped, maxHp) };
}

/**
 * One combatant's overhead label, targeting tags and always-visible cast progress.
 * Canvas feet bars own the visual health presentation; DOM health remains available
 * to assistive tech and becomes visible when the canvas cannot render.
 */
export function SeatLabel(props: {
  player: Player;
  isSelf: boolean;
  isTarget: boolean;
  aimedAtMe: boolean;
  render: RenderMode;
  /** The viewer's own readout follows local typing instead of a snapshot ack. */
  selfCast: { progress: number; length: number };
}) {
  const eliminated = createMemo(() => props.player.eliminatedAt !== null);
  const tone = createMemo(() => hpTone(props.player.hp, props.player.maxHp, eliminated()));
  const cast = () =>
    props.isSelf
      ? { progress: Math.max(0, props.selfCast.progress), length: props.selfCast.length }
      : { progress: props.player.progress, length: props.player.spellLength };
  const castPercent = createMemo(() =>
    eliminated() ? 0 : percentOf(cast().progress, cast().length),
  );
  const castText = () =>
    eliminated()
      ? '施法中断'
      : castPercent() >= 85
        ? `即将施法 ${castPercent()}%`
        : `咏唱进度 ${castPercent()}%`;
  /**
   * The readout darkens a downed bar; the player's own bar keeps its normal
   * gradient, mirroring the two rules the old sheet had.
   */
  const barTone = createMemo(() => {
    const ratio = tone().ratio;
    return ratio === 'down' && !props.isSelf ? 'none' : ratio;
  });

  return (
    <div
      class={stylex.props(styles.seatLabel, eliminated() && styles.seatLabelDown).className}
      data-testid="arena-seat"
      data-user={props.player.id}
      data-self={String(props.isSelf)}
      data-slot={props.player.slot}
      data-connected={String(props.player.connected)}
      data-target={String(props.isTarget)}
      data-aiming={String(props.aimedAtMe)}
      data-eliminated={String(eliminated())}
      data-hp={Math.max(0, props.player.hp)}
      data-max-hp={props.player.maxHp}
      role="listitem"
    >
      <span
        class={stylex.props(styles.seatName, props.isSelf && styles.seatNameSelf).className}
        data-testid="arena-seat-name"
      >
        {`${props.player.username}${props.isSelf ? '（你）' : ''}`}
      </span>
      <div class={stylex.props(styles.seatTags).className}>
        <span
          class={stylex.props(styles.mark, styles.markTarget).className}
          data-testid="arena-target-mark"
          hidden={!props.isTarget}
        >
          目标
        </span>
        <span
          class={stylex.props(styles.mark, styles.markAim).className}
          data-testid="arena-aim-mark"
          hidden={!props.aimedAtMe}
        >
          瞄准你
        </span>
        <span
          class={stylex.props(styles.mark, styles.markDown).className}
          data-testid="arena-down-mark"
          hidden={!eliminated()}
        >
          出局
        </span>
        <span
          class={stylex.props(styles.mark, styles.markOffline).className}
          data-testid="arena-offline-mark"
          hidden={props.player.connected}
        >
          离线
        </span>
      </div>
      <div
        class={stylex.props(props.render === 'dom' ? styles.seatReadout : ui.srOnly).className}
        data-testid="seat-readout"
      >
        <div class={stylex.props(styles.seatReadoutHp).className}>
          <div
            class={
              stylex.props(
                styles.hpbar,
                props.isSelf && styles.hpbarSelf,
                props.render === 'dom' && styles.hpbarDom,
              ).className
            }
            data-testid="arena-hp"
            data-hp={Math.max(0, props.player.hp)}
            data-max-hp={props.player.maxHp}
            data-state={tone().ratio}
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax={String(Math.max(0, props.player.maxHp))}
            aria-valuenow={formatAmount(Math.max(0, props.player.hp))}
            aria-valuetext={tone().text}
            aria-label="生命值"
          >
            <div
              class={
                stylex.props(
                  styles.hpbarFill,
                  barTone() === 'low' && styles.hpbarFillLow,
                  barTone() === 'critical' && styles.hpbarFillCritical,
                  barTone() === 'down' && styles.hpbarFillDown,
                ).className
              }
              data-testid="arena-hp-fill"
              style={`width:${tone().percent}%`}
            />
          </div>
          <span class={stylex.props(styles.hpbarText).className} data-testid="arena-hp-text">
            {tone().text}
          </span>
        </div>
      </div>
      <div class={stylex.props(styles.seatCast).className} data-ready={castPercent() >= 85}>
        <div
          class={stylex.props(styles.castbar).className}
          data-testid="player-progress"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={String(castPercent())}
          aria-valuetext={eliminated() ? '施法中断' : `${cast().progress} / ${cast().length} 字`}
          aria-label={`${props.player.username}的咒文进度`}
        >
          <div
            class={stylex.props(styles.castbarFill).className}
            style={`width:${castPercent()}%`}
          />
        </div>
        <span
          class={
            stylex.props(styles.seatCastText, castPercent() >= 85 && styles.seatCastReady).className
          }
          data-testid="player-progress-text"
        >
          {castText()}
        </span>
      </div>
    </div>
  );
}
