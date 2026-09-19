/**
 * 统一的通知设置交互界面，复用于 /me（完整面板）及匹配队列页面（紧凑单行）。
 * 不存在单独的设置页面：匹配页面会持续展示相同的开启引导，直到用户开启对局提醒。
 *
 * 开启通知的处理函数必须直接从点击事件中触发：`enable()` 在首次 await 之前
 * 立即发起权限请求，以确保浏览器将其识别为合法的用户手势交互。
 * 此处绝不在挂载或渲染时主动索取通知权限。
 */
import { Show, type JSX } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import { NOTIFICATION_LIMITS, type NotificationService } from '../../app/notifications';
import type { AppContext } from '../../app/context';
import { ui } from '../../ui/primitives';

const STATE_COPY: Record<'unsupported' | 'denied' | 'on' | 'off', string> = {
  unsupported: '当前浏览器或环境不支持对局提醒，游戏功能不受影响。',
  denied: '通知权限已被浏览器拒绝；如需提醒，请在浏览器站点设置中重新允许通知。',
  on: '已开启对局提醒。',
  off: '开启后，匹配成功、对局就绪和结算会在页面后台时尝试提醒。',
};

function settingsState(service: NotificationService): 'unsupported' | 'denied' | 'on' | 'off' {
  const permission = service.permission();
  if (permission === 'unsupported') return 'unsupported';
  if (service.enabled()) return 'on';
  return permission === 'denied' ? 'denied' : 'off';
}

export function NotificationSettings(props: { ctx: AppContext; compact?: boolean }): JSX.Element {
  const service = props.ctx.notifications;
  const state = () => settingsState(service);
  // 匹配队列页面仅展示可操作的引导行：一旦开启，或环境完全不支持通知时则自动隐藏。
  const visible = () => !props.compact || state() === 'off' || state() === 'denied';

  return (
    <Show when={visible()}>
      <div class={stylex.props(styles.box).className} data-testid="notifications-panel">
        <p class={stylex.props(ui.smallText).className} data-testid="notifications-state">
          {STATE_COPY[state()]}
        </p>
        <p class={stylex.props(ui.smallText, ui.faint).className}>{NOTIFICATION_LIMITS}</p>
        <Show when={state() === 'on' || state() === 'off'}>
          <div class={stylex.props(ui.buttonRow).className}>
            <Show
              when={state() === 'on'}
              fallback={
                <button
                  type="button"
                  class={stylex.props(ui.button, ui.small).className}
                  data-testid="notifications-enable"
                  onClick={() => void service.enable()}
                >
                  开启对局提醒
                </button>
              }
            >
              <button
                type="button"
                class={stylex.props(ui.button, ui.small, ui.ghost).className}
                data-testid="notifications-disable"
                onClick={() => service.disable()}
              >
                关闭对局提醒
              </button>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}

const styles = stylex.create({
  box: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
});
