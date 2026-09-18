import { createMemo } from 'solid-js';
import type { Player, RoomSnapshot } from '../../../../shared/protocol';
import * as stylex from '@stylexjs/stylex';
import { styles } from './battle.styles';
import { CRITICAL_HP_RATIO, LOW_HP_RATIO } from './battle-view';

/**
 * The combat status strip. It lives outside the arena in normal flow, so the cue
 * can never sit on the fighters, and it always carries a line of text: a neutral
 * standing summary when nothing is urgent, the threat when it is.
 */
export function ThreatBanner(props: {
  snapshot: RoomSnapshot;
  self: Player | undefined;
  players: Player[];
  myTarget: number | null;
  aimingAtMe: Player[];
}) {
  const view = createMemo(() => {
    const self = props.self;
    if (!self) return { tone: 'none' as const, urgent: false, text: '' };
    const ratio = self.maxHp > 0 ? self.hp / self.maxHp : 1;
    const alive = props.players.filter((player) => player.eliminatedAt === null);

    if (self.eliminatedAt !== null) {
      return {
        tone: 'none' as const,
        urgent: false,
        text: '你已出局 · 可以观看剩余战斗，或直接离开',
      };
    }
    const live = props.snapshot.phase === 'playing';
    if (!live) {
      const theme = props.snapshot.theme;
      return {
        tone: 'none' as const,
        urgent: false,
        text:
          props.snapshot.phase === 'lobby' || props.snapshot.phase === 'generating'
            ? `主题「${theme}」· 战场尚未开始`
            : `主题「${theme}」· 倒数结束后立即开始输入`,
      };
    }

    const aiming = props.aimingAtMe.map((player) => player.username).join('、');
    const target = props.players.find((player) => player.slot === props.myTarget)?.username;
    const low = ratio <= CRITICAL_HP_RATIO ? 'critical' : ratio <= LOW_HP_RATIO ? 'low' : 'ok';
    const parts: string[] = [];
    if (aiming) parts.push(`${aiming} 正在瞄准你`);
    if (low === 'critical') parts.push('生命极低，再中一次就会出局');
    else if (low === 'low') parts.push('生命偏低，稳住输出');

    const urgent = aiming !== '' || low !== 'ok';
    return {
      tone: urgent ? (low === 'ok' ? ('warn' as const) : ('critical' as const)) : ('none' as const),
      urgent,
      text: urgent
        ? parts.join(' · ')
        : `主题「${props.snapshot.theme}」· 目标 ${target ?? '—'} · 存活 ${alive.length} / ${props.players.length} 人`,
    };
  });

  return (
    <div
      class={
        stylex.props(
          styles.threat,
          view().tone === 'warn' && styles.threatWarn,
          view().tone === 'critical' && styles.threatCritical,
        ).className
      }
      data-testid="threat-banner"
      data-tone={view().tone}
      data-threat={String(view().urgent)}
      aria-live="polite"
    >
      {view().text}
    </div>
  );
}
