/**
 * The one quiet install affordance, only on /me. When the browser offers its own
 * install prompt we surface a button for it; otherwise a one-line pointer to the
 * browser menu. An already-installed (standalone) app says nothing.
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
    // iOS Safari reports installed home-screen web apps here instead.
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
