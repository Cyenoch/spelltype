import { createMemo } from 'solid-js';
import type { RoomSnapshot } from '../../../../shared/protocol';
import * as stylex from '@stylexjs/stylex';
import { styles } from './battle.styles';

/**
 * The one global clock. It shows the opening countdown, then the single combat
 * deadline; it never restarts per spell and never shows a frozen value from a
 * phase that has no clock.
 */
export function TimerBox(props: { phase: RoomSnapshot['phase']; remainingMs: number | null }) {
  const active = createMemo(() => props.remainingMs !== null);
  const soon = createMemo(
    () => active() && props.phase === 'playing' && (props.remainingMs as number) <= 30_000,
  );
  const urgent = createMemo(() => soon() && (props.remainingMs as number) <= 10_000);
  const remaining = createMemo(() => {
    if (props.remainingMs === null) return '—';
    const seconds = Math.ceil(Math.max(0, props.remainingMs) / 1000);
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  });
  const label = () => {
    if (props.remainingMs !== null) return props.phase === 'playing' ? '剩余时间' : '开场倒数';
    switch (props.phase) {
      case 'lobby':
        return '等待开始';
      case 'generating':
        return '正在生成咒文';
      case 'finished':
        return '本局已结束';
      default:
        return '等待中';
    }
  };

  return (
    <div
      class={stylex.props(styles.timer, urgent() && styles.timerUrgent).className}
      data-testid="match-timer-box"
    >
      <span
        class={
          stylex.props(
            styles.timerValue,
            soon() && styles.timerValueSoon,
            urgent() && styles.timerValueUrgent,
          ).className
        }
        data-testid="match-timer"
        data-remaining-ms={
          props.remainingMs === null ? 0 : Math.max(0, Math.round(props.remainingMs))
        }
      >
        {remaining()}
      </span>
      <span class={stylex.props(styles.timerLabel).className} data-testid="match-timer-label">
        {label()}
      </span>
    </div>
  );
}
