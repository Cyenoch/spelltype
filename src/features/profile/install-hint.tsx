/**
 * 仅在 /me 页面呈现的唯一下载安装入口。
 * 当浏览器提供原生安装提示时，展示对应的触发按钮；
 * 否则展示一行引导用户在浏览器菜单中操作的说明。
 * 已安装（独立窗口 standalone 模式）运行的应用不显示该提示。
 */
import { createSignal, onCleanup, onMount, Show, type JSX } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import { ui } from '../../ui/primitives';

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

const MENU_COPY = '想把它装到桌面？在浏览器菜单选择「安装」或「添加到主屏幕」。';

export function InstallHint(): JSX.Element {
  const [promptEvent, setPromptEvent] = createSignal<BeforeInstallPromptEvent | null>(null);
  const standalone = () =>
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari 上的主屏幕网页应用在此属性上报。
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  onMount(() => {
    const capture = (event: Event) => {
      event.preventDefault();
      setPromptEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', capture);
    onCleanup(() => window.removeEventListener('beforeinstallprompt', capture));
  });

  return (
    <Show when={!standalone()}>
      <div data-testid="install-hint">
        <Show
          when={promptEvent()}
          fallback={<p class={stylex.props(ui.smallText, ui.faint).className}>{MENU_COPY}</p>}
        >
          {(event) => (
            <button
              type="button"
              class={stylex.props(ui.button, ui.small, ui.ghost).className}
              data-testid="install-button"
              onClick={() => void event().prompt()}
            >
              安装到桌面
            </button>
          )}
        </Show>
      </div>
    </Show>
  );
}
