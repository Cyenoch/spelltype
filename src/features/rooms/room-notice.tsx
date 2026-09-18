import { Show } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import type { RoomSnapshot } from '../../../shared/protocol';
import { ui } from '../../ui/primitives';
import type { RoomProblem, RoomSession } from './room-session';
import { styles } from './room-view.styles';

/**
 * The room's one failure notice. A quick match offers the queue again, a private
 * room a fresh one; both keep a way home, so a dead room is never a dead end.
 * Both exits use the session's acknowledged departure; navigating alone leaves
 * a matched ticket pointing back to the room whose snapshot just failed.
 * A version mismatch is the exception: the only fix is reloading the page, so
 * the notice swaps its room-creating action for a reload button instead of
 * sending the player to create a room this stale page still cannot join.
 */
export function RoomNotice(props: {
  problem: RoomProblem;
  snapshot: RoomSnapshot | null;
  leaveRoom: RoomSession['leaveRoom'];
  leavePending: boolean;
}) {
  return (
    <div
      class={
        stylex.props(
          ui.notice,
          styles.noticeLayout,
          props.problem.tone === 'error' ? styles.noticeError : styles.noticeWarn,
        ).className
      }
      data-testid="room-error"
      data-tone={props.problem.tone}
      role="alert"
    >
      <span class={stylex.props(ui.noticeIcon).className} aria-hidden="true">
        ✖
      </span>
      <div class={stylex.props(styles.noticeMessage).className}>{props.problem.message}</div>
      <div class={stylex.props(ui.buttonRow, styles.noticeActions).className}>
        <Show when={!props.problem.reload && props.snapshot}>
          {(room) => (
            <button
              type="button"
              class={stylex.props(ui.button, ui.small, ui.gold).className}
              data-testid="room-error-retry"
              disabled={props.leavePending}
              onClick={() => void props.leaveRoom(room().mode === 'quick' ? '/match' : '/create')}
            >
              {room().mode === 'quick' ? '重新匹配' : '创建新房间'}
            </button>
          )}
        </Show>
        <Show when={props.problem.reload}>
          <button
            type="button"
            class={stylex.props(ui.button, ui.small, ui.gold).className}
            data-testid="room-reload"
            onClick={() => location.reload()}
          >
            刷新页面
          </button>
        </Show>
        <button
          type="button"
          class={stylex.props(ui.button, ui.small).className}
          data-testid="room-error-home"
          disabled={props.leavePending}
          onClick={() => void props.leaveRoom()}
        >
          {props.leavePending ? '正在离开…' : '返回首页'}
        </button>
      </div>
    </div>
  );
}
