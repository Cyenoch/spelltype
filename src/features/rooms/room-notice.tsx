import { Show } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import type { RoomSnapshot } from '../../../shared/protocol';
import { ui } from '../../ui/primitives';
import type { RoomProblem, RoomSession } from './room-session';
import { styles } from './room-view.styles';

/**
 * 房间唯一的失败提示。快速匹配会再给一次排队入口，私人房则给一次新建入口；
 * 两者都保留一条回家路径，因此一个死掉的房间绝不会成为死胡同。
 * 两条出口都走会话中已确认的离场流程；仅靠导航离开会让一张已配对的票据
 * 继续指向那个快照刚刚失败了的房间。
 * 版本不匹配是例外：唯一的修复办法是重新加载页面，
 * 因此提示会把「创建房间」动作换成刷新按钮，
 * 而不是把玩家送去创建一个这个陈旧页面依然加入不了的新房间。
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
