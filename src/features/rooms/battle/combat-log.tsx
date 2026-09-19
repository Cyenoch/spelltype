import { For, Show, createMemo } from 'solid-js';
import type { CombatEvent, Player } from '../../../../shared/protocol';
import { formatAmount } from '../../../ui/format';
import { ui } from '../../../ui/primitives';
import * as stylex from '@stylexjs/stylex';
import { styles } from './battle.styles';

/** 房间保留 32 条事件的环形缓冲区；可见日志与这一上限保持一致。 */
const LOG_LIMIT = 32;

/**
 * 房间自身的战斗日志，上限即快照所携带的事件环。
 * 条目按序号从快照中查找，因此重新下发的快照绝不会
 * 打乱顺序或重复玩家已经读过的内容。
 */
export function CombatLog(props: { events: CombatEvent[]; players: Player[] }) {
  const logSeqs = createMemo(() => {
    const events = props.events;
    return events.slice(Math.max(0, events.length - LOG_LIMIT)).map((event) => event.seq);
  });

  return (
    <div class={stylex.props(styles.side).className}>
      <h3 class={stylex.props(styles.sideTitle).className}>施法记录</h3>
      <div
        class={stylex.props(styles.log).className}
        data-testid="combat-log"
        role="log"
        aria-label="最近的施法记录"
      >
        <Show when={logSeqs().length === 0}>
          <p class={stylex.props(ui.smallText, ui.faint).className} data-testid="combat-log-empty">
            还没有人完成咒文。
          </p>
        </Show>
        <For each={logSeqs()}>
          {(seq) => (
            <Show when={props.events.find((event) => event.seq === seq)}>
              {(event) => <LogEntry event={event()} players={props.players} />}
            </Show>
          )}
        </For>
      </div>
    </div>
  );
}

/** 一条伤害条目：谁打了谁、伤害多少，以及之后剩余的生命值。 */
function LogEntry(props: { event: CombatEvent; players: Player[] }) {
  const nameOf = (id: string) =>
    props.players.find((player) => player.id === id)?.username ?? '未知玩家';
  const element = createMemo(() => props.event.element);

  return (
    <div
      class={stylex.props(styles.logEntry).className}
      data-testid="combat-log-entry"
      data-seq={props.event.seq}
      data-attacker={props.event.attackerId}
      data-target={props.event.targetId}
      data-damage={props.event.damage}
      data-element={props.event.element}
      data-eliminated={String(props.event.eliminated)}
    >
      <span class={stylex.props(styles.logText).className}>
        {`${nameOf(props.event.attackerId)} → ${nameOf(props.event.targetId)}`}
      </span>
      <span
        class={
          stylex.props(
            styles.logDamage,
            element() === 'ice' && styles.logDamageIce,
            element() === 'storm' && styles.logDamageStorm,
            element() === 'arcane' && styles.logDamageArcane,
          ).className
        }
        data-element={props.event.element}
      >
        {`-${formatAmount(props.event.damage)}`}
      </span>
      <span class={stylex.props(styles.logHp).className}>
        {`${formatAmount(props.event.targetHp)} 剩余`}
      </span>
      <Show when={props.event.eliminated}>
        <span class={stylex.props(styles.mark, styles.markDown).className}>击倒</span>
      </Show>
    </div>
  );
}
