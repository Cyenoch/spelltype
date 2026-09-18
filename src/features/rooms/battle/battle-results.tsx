import { For, Show, createMemo, onMount } from 'solid-js';
import type { Player, RoomSnapshot } from '../../../../shared/protocol';
import {
  END_REASON_LABELS,
  formatAccuracyPercent,
  formatAmount,
  formatHealth,
  formatSeconds,
} from '../../../ui/format';
import { ui } from '../../../ui/primitives';
import * as stylex from '@stylexjs/stylex';
import { styles } from './battle.styles';

const PERSISTENCE_TEXT: Record<'idle' | 'saving' | 'saved' | 'error', string> = {
  idle: '对决结束后保存战绩',
  saving: '正在保存战绩…',
  saved: '战绩已保存到账号',
  error: '战绩暂未保存，正在自动重试',
};

type Outcome = 'win' | 'loss' | 'draw' | 'finished';

/** Published ranks decide order; tied rows retain stable seating, not a hidden score tiebreak. */
function ranked(players: Player[]): Player[] {
  return [...players].sort((a, b) => {
    const rankA = a.rank ?? Number.POSITIVE_INFINITY;
    const rankB = b.rank ?? Number.POSITIVE_INFINITY;
    if (rankA !== rankB) return rankA - rankB;
    return a.slot - b.slot;
  });
}

/**
 * Dedicated settled screen: clear outcome and primary actions first, then the
 * viewer's figures, the full standings and the room's save state.
 */
export function BattleResults(props: {
  snapshot: RoomSnapshot;
  self: Player | undefined;
  players: Player[];
  onRematch(): void;
  onLeave(): void;
}) {
  let heading!: HTMLHeadingElement;
  const rank = () => props.self?.rank ?? null;
  const tied = () =>
    rank() !== null &&
    props.players.some((player) => player.id !== props.self?.id && player.rank === rank());
  const outcome = createMemo<Outcome>(() => {
    if (rank() === null) return 'finished';
    if (rank() !== 1) return 'loss';
    return props.players.some((player) => player.rank === 1 && player.id !== props.self?.id)
      ? 'draw'
      : 'win';
  });
  onMount(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    heading.focus({ preventScroll: true });
  });
  const rows = createMemo(() => ranked(props.players));
  const rowIds = createMemo(() => rows().map((player) => player.id));
  const reason = () =>
    props.snapshot.endReason ? END_REASON_LABELS[props.snapshot.endReason] : '对局已结束';
  const duration = () =>
    props.snapshot.startedAt !== null && props.snapshot.endedAt !== null
      ? ` · 战斗时长 ${formatSeconds(props.snapshot.endedAt - props.snapshot.startedAt)} 秒`
      : '';

  return (
    <section
      class={stylex.props(styles.results).className}
      data-testid="final-panel"
      data-outcome={outcome()}
      aria-labelledby="result-title"
    >
      <div
        class={
          stylex.props(
            styles.result,
            outcome() === 'win' && styles.resultWin,
            outcome() === 'loss' && styles.resultDown,
            outcome() === 'draw' && styles.resultDraw,
          ).className
        }
        data-testid="result-banner"
        data-outcome={outcome()}
        data-end-reason={props.snapshot.endReason ?? ''}
      >
        <p class={stylex.props(ui.eyebrow).className}>对局已结束</p>
        <h1
          id="result-title"
          tabIndex={-1}
          ref={(el) => {
            heading = el;
          }}
          class={
            stylex.props(styles.resultTitle, outcome() === 'win' && styles.resultTitleWin).className
          }
          data-testid="result-title"
        >
          {outcome() === 'win'
            ? '胜利'
            : outcome() === 'loss'
              ? '失败'
              : outcome() === 'draw'
                ? '平局'
                : '对局结束'}
        </h1>
        <p class={stylex.props(styles.resultRank).className}>
          {rank() === null
            ? '名次尚未公布'
            : `${tied() ? '并列' : ''}第 ${rank()} 名 · 共 ${props.players.length} 位玩家`}
        </p>
        <p class={stylex.props(styles.resultDetail).className} data-testid="result-detail">
          {props.self
            ? `${reason()}${duration()}。你完成 ${props.self.spellsCast} 次施法，造成 ${formatAmount(props.self.damageDealt)} 点伤害，剩余生命 ${formatHealth(props.self.hp, props.self.maxHp)}。`
            : `${reason()}${duration()}。`}
          {outcome() === 'draw'
            ? props.self?.eliminatedAt !== null
              ? '最后的存活者在同一批结算中同时出局，并列第一。'
              : '时间到，剩余生命完全相同，并列第一。'
            : ''}
        </p>
      </div>
      <div class={stylex.props(ui.buttonRow, styles.resultActions).className}>
        <button
          type="button"
          class={stylex.props(ui.button, ui.primary).className}
          data-testid="rematch"
          disabled={props.snapshot.draining}
          onClick={() => props.onRematch()}
        >
          再来一局
        </button>
        <button
          type="button"
          class={stylex.props(ui.button, ui.ghost).className}
          data-testid="final-leave"
          onClick={() => props.onLeave()}
        >
          返回首页
        </button>
      </div>
      <Show when={props.snapshot.draining}>
        <p class={stylex.props(styles.resultDetail).className}>
          此版本已停止接受新对局，请返回首页后更新。
        </p>
      </Show>

      <div class={stylex.props(ui.statTiles).className}>
        <div class={stylex.props(ui.tile).className}>
          <div class={stylex.props(ui.tileLabel).className}>我的名次</div>
          <div class={stylex.props(ui.tileValue).className} data-testid="final-self-rank">
            {rank() === null ? '—' : `#${rank()}`}
          </div>
        </div>
        <div class={stylex.props(ui.tile).className}>
          <div class={stylex.props(ui.tileLabel).className}>造成伤害</div>
          <div class={stylex.props(ui.tileValue).className} data-testid="final-self-damage">
            {formatAmount(props.self?.damageDealt ?? 0)}
          </div>
        </div>
        <div class={stylex.props(ui.tile).className}>
          <div class={stylex.props(ui.tileLabel).className}>成功施法</div>
          <div class={stylex.props(ui.tileValue).className} data-testid="final-self-spells">
            {String(props.self?.spellsCast ?? 0)}
          </div>
        </div>
        <div class={stylex.props(ui.tile).className}>
          <div class={stylex.props(ui.tileLabel).className}>速度 · 字/分钟</div>
          <div class={stylex.props(ui.tileValue).className} data-testid="final-self-cpm">
            {props.self ? String(Math.round(props.self.cpm)) : '—'}
          </div>
        </div>
        <div class={stylex.props(ui.tile).className}>
          <div class={stylex.props(ui.tileLabel).className}>准确率</div>
          <div class={stylex.props(ui.tileValue).className} data-testid="final-self-accuracy">
            {formatAccuracyPercent(props.self?.accuracy ?? null)}
          </div>
        </div>
      </div>

      <div class={stylex.props(ui.resultsWrap).className}>
        <table class={stylex.props(ui.table).className} data-testid="final-results">
          <thead>
            <tr>
              <th class={stylex.props(ui.th).className}>名次</th>
              <th class={stylex.props(ui.th).className}>玩家</th>
              <th class={stylex.props(ui.th, ui.num).className}>剩余生命</th>
              <th class={stylex.props(ui.th, ui.num).className}>造成伤害</th>
              <th class={stylex.props(ui.th, ui.num).className}>施法</th>
              <th class={stylex.props(ui.th, ui.num).className}>字/分钟</th>
              <th class={stylex.props(ui.th, ui.num).className}>准确率</th>
            </tr>
          </thead>
          <tbody>
            <For each={rowIds()}>
              {(id) => {
                const row = createMemo(() => rows().find((player) => player.id === id) as Player);
                const isSelf = createMemo(() => id === props.self?.id);
                const eliminated = createMemo(() => row().eliminatedAt !== null);
                const rank = createMemo(() => row().rank);
                return (
                  <tr
                    data-testid="final-row"
                    data-user={row().id}
                    data-rank={row().rank ?? ''}
                    data-self={String(isSelf())}
                    data-eliminated={String(eliminated())}
                    data-hp={Math.max(0, row().hp)}
                  >
                    <td
                      class={
                        stylex.props(
                          ui.td,
                          isSelf() && styles.cellSelf,
                          eliminated() && styles.cellDown,
                          styles.rankMedal,
                          rank() === 1 && styles.rankMedalFirst,
                          rank() === 2 && styles.rankMedalSecond,
                          rank() === 3 && styles.rankMedalThird,
                          rank() === 1 && styles.cellRankFirst,
                        ).className
                      }
                      data-testid="final-row-rank"
                      data-rank={rank() ?? ''}
                    >
                      {rank() === null ? '—' : `#${rank()}`}
                    </td>
                    <td
                      class={
                        stylex.props(
                          ui.td,
                          isSelf() && styles.cellSelf,
                          eliminated() && styles.cellDown,
                        ).className
                      }
                    >
                      {`${row().username}${isSelf() ? '（你）' : ''}${eliminated() ? ' · 出局' : ''}`}
                    </td>
                    <td
                      class={
                        stylex.props(
                          ui.td,
                          ui.num,
                          isSelf() && styles.cellSelf,
                          eliminated() && styles.cellDown,
                        ).className
                      }
                      data-testid="final-row-hp"
                      data-hp={Math.max(0, row().hp)}
                      data-max-hp={row().maxHp}
                    >
                      {formatHealth(row().hp, row().maxHp)}
                    </td>
                    <td
                      class={
                        stylex.props(
                          ui.td,
                          ui.num,
                          isSelf() && styles.cellSelf,
                          eliminated() && styles.cellDown,
                        ).className
                      }
                      data-testid="final-row-damage"
                    >
                      {formatAmount(row().damageDealt)}
                    </td>
                    <td
                      class={
                        stylex.props(
                          ui.td,
                          ui.num,
                          isSelf() && styles.cellSelf,
                          eliminated() && styles.cellDown,
                        ).className
                      }
                      data-testid="final-row-spells"
                    >
                      {String(row().spellsCast)}
                    </td>
                    <td
                      class={
                        stylex.props(
                          ui.td,
                          ui.num,
                          isSelf() && styles.cellSelf,
                          eliminated() && styles.cellDown,
                        ).className
                      }
                      data-testid="final-row-cpm"
                    >
                      {String(Math.round(row().cpm))}
                    </td>
                    <td
                      class={
                        stylex.props(
                          ui.td,
                          ui.num,
                          isSelf() && styles.cellSelf,
                          eliminated() && styles.cellDown,
                        ).className
                      }
                      data-testid="final-row-accuracy"
                    >
                      {formatAccuracyPercent(row().accuracy)}
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
      </div>

      <p
        class={stylex.props(ui.smallText, ui.muted).className}
        data-testid="save-status"
        data-state={props.snapshot.persistence}
      >
        {PERSISTENCE_TEXT[props.snapshot.persistence]}
      </p>
    </section>
  );
}
