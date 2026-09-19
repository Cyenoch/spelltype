import { createMemo } from 'solid-js';
import type { Player } from '../../../../shared/protocol';
import { formatAccuracyPercent, formatAmount, formatHealth, percentOf } from '../../../ui/format';
import * as stylex from '@stylexjs/stylex';
import { styles } from './battle.styles';

/** 观察者自身的生命值与数据，每一项都读自快照。 */
export function BattleSelfbar(props: { self: Player | undefined }) {
  const selfHp = createMemo(() => {
    const self = props.self;
    const maxHp = self?.maxHp ?? 0;
    const hp = self ? Math.max(0, self.hp) : 0;
    const percent = percentOf(hp, maxHp);
    return {
      percent,
      state:
        maxHp <= 0
          ? 'unknown'
          : hp <= 0
            ? 'down'
            : percent <= 15
              ? 'critical'
              : percent <= 35
                ? 'low'
                : 'ok',
      text: maxHp > 0 ? formatHealth(hp, maxHp) : '— / —',
      maxHp,
      hp,
    };
  });

  return (
    <div class={stylex.props(styles.selfbar).className} data-testid="self-status">
      <div class={stylex.props(styles.selfbarHp).className}>
        <span class={stylex.props(styles.selfbarLabel).className}>我的生命</span>
        <div
          class={stylex.props(styles.hpbar, styles.hpbarSelf).className}
          data-testid="self-hp"
          data-state={selfHp().state}
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax={String(Math.max(0, selfHp().maxHp))}
          aria-valuenow={formatAmount(selfHp().hp)}
          aria-valuetext={selfHp().maxHp > 0 ? formatHealth(selfHp().hp, selfHp().maxHp) : '—'}
          aria-label="我的生命值"
        >
          <div
            class={
              stylex.props(
                styles.hpbarFill,
                selfHp().state === 'low' && styles.hpbarFillLow,
                selfHp().state === 'critical' && styles.hpbarFillCritical,
              ).className
            }
            data-testid="self-hp-fill"
            style={`width:${selfHp().percent}%`}
          />
        </div>
        <span class={stylex.props(styles.hpbarText).className} data-testid="self-hp-text">
          {selfHp().text}
        </span>
      </div>
      <div class={stylex.props(styles.selfbarStats).className}>
        <span>
          CPM{' '}
          <b class={stylex.props(styles.selfbarStat).className} data-testid="self-cpm">
            {props.self ? String(Math.round(props.self.cpm)) : '—'}
          </b>
        </span>
        <span>
          施法{' '}
          <b class={stylex.props(styles.selfbarStat).className} data-testid="self-spells">
            {String(props.self?.spellsCast ?? 0)}
          </b>
        </span>
        <span>
          准确率{' '}
          <b class={stylex.props(styles.selfbarStat).className} data-testid="self-accuracy">
            {formatAccuracyPercent(props.self?.accuracy ?? null)}
          </b>
        </span>
        <span>
          伤害{' '}
          <b class={stylex.props(styles.selfbarStat).className} data-testid="self-damage">
            {formatAmount(props.self?.damageDealt ?? 0)}
          </b>
        </span>
        <span>
          名次{' '}
          <b class={stylex.props(styles.selfbarStat).className} data-testid="self-rank">
            {props.self?.rank == null ? '—' : `#${props.self.rank}`}
          </b>
        </span>
      </div>
    </div>
  );
}
