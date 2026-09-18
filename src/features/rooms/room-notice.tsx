import { Show } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import type { RoomSnapshot } from '../../../shared/protocol';
import { ui } from '../../ui/primitives';
import type { RoomProblem } from './room-session';
import { styles } from './room-view.styles';

/**
 * The room's one failure notice. A quick match offers the queue again, a private
 * room a fresh one; both keep a way home, so a dead room is never a dead end.
 */
export function RoomNotice(props: { problem: RoomProblem; snapshot: RoomSnapshot | null }) {
  const navigate = useNavigate();
  return (
    <div
      class={
        stylex.props(
          ui.notice,
          props.problem.tone === 'error' ? styles.noticeError : styles.noticeWarn,
        ).className
      }
      data-testid="room-error"
      data-tone={props.problem.tone}
    >
      <span class={stylex.props(ui.noticeIcon).className}>✖</span>
      <div>{props.problem.message}</div>
      <div class={stylex.props(ui.buttonRow).className}>
        <Show when={props.snapshot}>
          {(room) => (
            <button
              type="button"
              class={stylex.props(ui.button, ui.small, ui.gold).className}
              data-testid="room-error-retry"
              onClick={() =>
                void (room().mode === 'quick'
                  ? navigate({ to: '/match', search: { difficulty: room().difficulty } })
                  : navigate({ to: '/create', search: {} }))
              }
            >
              {room().mode === 'quick' ? '重新匹配' : '创建新房间'}
            </button>
          )}
        </Show>
        <button
          type="button"
          class={stylex.props(ui.button, ui.small).className}
          data-testid="room-error-home"
          onClick={() => void navigate({ to: '/', search: {} })}
        >
          返回首页
        </button>
      </div>
    </div>
  );
}
