import { Link } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { useQuery } from '@tanstack/solid-query';
import { Show, createEffect, createMemo, on } from 'solid-js';
import { formatDuration } from '../../ui/format';
import { activityOptions } from '../../app/queries';
import type { AppContext } from '../../app/context';
import { NotificationSettings } from '../profile/notification-settings';
import { ui } from '../../ui/primitives';
import { createMatchQueue } from './queue-controller';
import { QueueStage } from './queue-stage';
import { QueuePractice } from './queue-practice';
import { styles } from './queue-view.styles';

/** 服务端掌控的匹配状态，以及仅在本地运行的打字练习面板。 */
export function QueueView(props: { ctx: AppContext }) {
  const queue = createMatchQueue(props);
  const searching = createMemo(() => queue.state() === 'waiting');
  const settled = createMemo(() => queue.state() === 'cancelled' || queue.state() === 'blocked');

  /** 实时在线人数，读取自首页计数轮询接口（10 秒刷新，5 秒判定陈旧）。 */
  const activity = useQuery(() => activityOptions);

  // 加入、离开或重新排队均会改变本页面展示的在线人数，
  // 因此主动使共享计数失效重新拉取，而非等待其常规轮询间隔。
  createEffect(
    on(
      () => queue.state(),
      () => {
        void props.ctx.queryClient.invalidateQueries({ queryKey: activityOptions.queryKey });
      },
      { defer: true },
    ),
  );

  return (
    <section
      data-testid="view-queue"
      data-state={queue.state()}
      data-retry={queue.retry() ? 'true' : undefined}
    >
      <QueueStage
        state={queue.state()}
        username={props.ctx.session.user?.username ?? '未登录'}
        retry={queue.retry()}
      />

      <div class={stylex.props(styles.workspace).className}>
        <div class={stylex.props(ui.panel, styles.brief).className} data-testid="queue-panel">
          <div class={stylex.props(ui.panelHead).className}>
            <div class={stylex.props(styles.titleGroup).className}>
              <h1>快速匹配</h1>
              <span class={stylex.props(ui.eyebrow).className}>1v1</span>
            </div>
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

          <div
            class={stylex.props(ui.statTiles, styles.facts).className}
            data-testid="queue-activity-state"
            // `stale`：保留上一次真实响应数值 · `error`：从未获取到任何数据。
            data-state={
              activity.isPending
                ? 'loading'
                : activity.error
                  ? activity.data
                    ? 'stale'
                    : 'error'
                  : 'ready'
            }
          >
            <div class={stylex.props(ui.tile, styles.fact).className}>
              <div class={stylex.props(ui.tileLabel).className}>已等待</div>
              <div
                class={stylex.props(ui.tileValue, styles.elapsed).className}
                data-testid="queue-elapsed"
              >
                {formatDuration(queue.elapsed())}
              </div>
            </div>
            <div class={stylex.props(ui.tile, styles.fact).className}>
              <div class={stylex.props(ui.tileLabel).className}>正在排队</div>
              <div class={stylex.props(ui.tileValue).className} data-testid="queue-waiting-players">
                {activity.data === undefined ? '—' : activity.data.waitingPlayers}
              </div>
            </div>
            <div class={stylex.props(ui.tile, styles.fact).className}>
              <div class={stylex.props(ui.tileLabel).className}>进行中对局</div>
              <div class={stylex.props(ui.tileValue).className} data-testid="queue-active-duels">
                {activity.data === undefined ? '—' : activity.data.activeDuels}
              </div>
            </div>
          </div>
          <Show
            when={activity.isPending || activity.error}
            fallback={
              <p class={stylex.props(styles.activityNote).className}>
                人数每 10 秒刷新 · 仅统计正在排队的玩家，不是在线总人数。
              </p>
            }
          >
            <p
              class={
                stylex.props(styles.activityNote, activity.error ? styles.activityNoteError : null)
                  .className
              }
              data-testid="queue-activity-note"
              role="status"
            >
              {activity.isPending
                ? '正在获取活动数据…'
                : activity.data
                  ? '活动数据暂时无法刷新，以上人数可能不是最新。'
                  : '活动数据暂时无法获取，稍后自动重试。'}
            </p>
          </Show>

          <div class={stylex.props(ui.buttonRow).className}>
            <button
              type="button"
              class={stylex.props(ui.button, ui.danger).className}
              data-testid="queue-cancel"
              hidden={queue.state() === 'cancelled'}
              disabled={queue.cancelPending() || queue.state() === 'matched'}
              onClick={() => queue.cancel()}
            >
              {queue.state() === 'matched'
                ? '正在进入房间…'
                : queue.state() === 'blocked'
                  ? '取消已有排队'
                  : '取消等待'}
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
        <QueuePractice active={searching()} />
        <NotificationSettings ctx={props.ctx} compact />
      </div>
    </section>
  );
}
