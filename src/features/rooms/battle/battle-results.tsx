import { For, createMemo } from 'solid-js';
import type { Player, RoomSnapshot } from '../../../../shared/protocol';
import {
  END_REASON_LABELS,
  formatAccuracyPercent,
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

type Outcome = 'win' | 'down' | 'place';

/** Ranking order the settled screen reads: published rank, then health, damage, seat. */
function ranked(players: Player[]): Player[] {
  return [...players].sort((a, b) => {
    const rankA = a.rank ?? Number.POSITIVE_INFINITY;
    const rankB = b.rank ?? Number.POSITIVE_INFINITY;
    if (rankA !== rankB) return rankA - rankB;
    return b.hp - a.hp || b.damageDealt - a.damageDealt || a.slot - b.slot;
  });
}

function outcomeOf(rank: number | null, self: Player | undefined): Outcome {
  if (rank === 1) return 'win';
  return self?.eliminatedAt != null ? 'down' : 'place';
}

/**
 * The settled screen: one banner, the viewer's own figures, the full table and
 * the room's save state. The panel is always mounted and toggled with `hidden`,
 * so bringing the result into view once can rely on a node that already exists.
 */
export function BattleResults(props: {
  snapshot: RoomSnapshot;
  self: Player | undefined;
  players: Player[];
  panelRef(el: HTMLElement): void;
  onRematch(): void;
  onLeave(): void;
}) {
  const finished = () => props.snapshot.phase === 'finished';
  const rank = () => props.self?.rank ?? null;
  const outcome = createMemo(() => outcomeOf(rank(), props.self));
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
      hidden={!finished()}
      ref={(el) => props.panelRef(el)}
    >
      <div
        class={
          stylex.props(
            styles.result,
            outcome() === 'win' && styles.resultWin,
            outcome() === 'down' && styles.resultDown,
          ).className
        }
        data-testid="result-banner"
        data-outcome={outcome()}
        data-end-reason={props.snapshot.endReason ?? ''}
      >
        <h2
          class={
            stylex.props(styles.resultTitle, outcome() === 'win' && styles.resultTitleWin).className
          }
          data-testid="result-title"
        >
          {outcome() === 'win'
            ? '胜利'
            : outcome() === 'down'
              ? `你被击倒了${rank() === null ? '' : ` · 第 ${rank()} 名`}`
              : rank() === null
                ? '对局结束'
                : `第 ${rank()} 名`}
        </h2>
        <p class={stylex.props(styles.resultDetail).className} data-testid="result-detail">
          {props.self
            ? `${reason()}${duration()}。你完成 ${props.self.spellsCast} 次施法，造成 ${props.self.damageDealt} 点伤害，剩余生命 ${formatHealth(props.self.hp, props.self.maxHp)}。`
            : `${reason()}${duration()}。`}
        </p>
      </div>

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
            {String(props.self?.damageDealt ?? 0)}
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
                      {String(row().damageDealt)}
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

      <div class={stylex.props(ui.buttonRow).className}>
        <button
          type="button"
          class={stylex.props(ui.button, ui.primary).className}
          data-testid="rematch"
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
          离开房间
        </button>
      </div>
    </section>
  );
}
