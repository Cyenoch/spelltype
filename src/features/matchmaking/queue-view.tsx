import { Link } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { createMemo } from 'solid-js';
import { DIFFICULTY_HINTS, DIFFICULTY_LABELS, formatDuration } from '../../ui/format';
import type { AppContext } from '../../app/context';
import { ui } from '../../ui/primitives';
import { createMatchQueue } from './queue-controller';
import { QueueStage } from './queue-stage';
import { styles } from './queue-view.styles';
import type { Difficulty } from '../../../shared/protocol';

/**
 * Matchmaking status and controls. Every word of status comes from the lease the
 * server hands back per poll; the only local clock is the waiting time itself.
 */
export function QueueView(props: { ctx: AppContext; difficulty: Difficulty }) {
  const queue = createMatchQueue(props);
  const searching = createMemo(() => queue.state() === 'waiting');
  const settled = createMemo(() => queue.state() === 'cancelled' || queue.state() === 'blocked');

  return (
    <section
      data-testid="view-queue"
      data-state={queue.state()}
      data-retry={queue.retry() ? 'true' : undefined}
      data-motion={queue.paused() ? 'paused' : 'full'}
    >
      <QueueStage
        state={queue.state()}
        username={props.ctx.session.user?.username ?? '未登录'}
        paused={queue.paused()}
        retry={queue.retry()}
      />

      <div class={stylex.props(ui.panel, styles.brief).className} data-testid="queue-panel">
        <div class={stylex.props(ui.panelHead).className}>
          <h1>快速匹配</h1>
          <span class={stylex.props(ui.eyebrow).className}>1v1 · 同难度</span>
          <button
            type="button"
            class={
              stylex.props(
                ui.button,
                ui.small,
                ui.ghost,
                styles.motion,
                searching() ? null : styles.motionSettled,
              ).className
            }
            data-testid="queue-motion"
            aria-pressed={queue.paused()}
            onClick={() => queue.toggleMotion()}
          >
            {queue.paused() ? '开启动效' : '暂停动效'}
          </button>
        </div>

        <p
          class={stylex.props(styles.state, settled() ? styles.stateSettled : null).className}
          data-testid="queue-state"
          data-state={queue.state()}
          aria-live="polite"
        >
          {queue.message()}
        </p>

        <div
          class={stylex.props(ui.notice, styles.noticeError, styles.error).className}
          data-testid="queue-error"
          data-tone="error"
          hidden={queue.error() === null}
        >
          <span class={stylex.props(ui.noticeIcon).className} aria-hidden="true">
            ✖
          </span>
          <span>{queue.error() ?? ''}</span>
        </div>

        <div class={stylex.props(ui.statTiles, styles.facts).className}>
          <div class={stylex.props(ui.tile).className}>
            <div class={stylex.props(ui.tileLabel).className}>难度</div>
            <div class={stylex.props(ui.tileValue).className} data-testid="queue-difficulty">
              {DIFFICULTY_LABELS[props.difficulty]}
            </div>
            <p class={stylex.props(ui.smallText, ui.faint, styles.difficultyHint).className}>
              {DIFFICULTY_HINTS[props.difficulty]}
            </p>
          </div>
          <div class={stylex.props(ui.tile).className}>
            <div class={stylex.props(ui.tileLabel).className}>已等待</div>
            <div
              class={stylex.props(ui.tileValue, styles.elapsed).className}
              data-testid="queue-elapsed"
            >
              {formatDuration(queue.elapsed())}
            </div>
          </div>
        </div>

        <div class={stylex.props(ui.buttonRow).className}>
          <button
            type="button"
            class={stylex.props(ui.button, ui.danger).className}
            data-testid="queue-cancel"
            hidden={queue.state() === 'matched' || queue.state() === 'cancelled'}
            disabled={queue.cancelPending()}
            onClick={() => queue.cancel()}
          >
            {queue.state() === 'blocked' ? '取消已有排队' : '取消等待'}
          </button>
          <button
            type="button"
            class={stylex.props(ui.button, ui.primary).className}
            data-testid="queue-requeue"
            hidden={queue.state() !== 'cancelled'}
            onClick={() => queue.requeue()}
          >
            重新排队
          </button>
          <Link
            class={stylex.props(ui.button, ui.ghost, styles.home).className}
            data-testid="queue-home"
            to="/"
            search={{}}
            rel="home"
          >
            返回首页
          </Link>
        </div>

        <p
          class={stylex.props(ui.smallText, ui.faint, styles.hint).className}
          data-testid="queue-expiry"
          hidden={queue.hint() === ''}
        >
          {queue.hint()}
        </p>
      </div>
    </section>
  );
}
