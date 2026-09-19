import { Show } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { ui } from '../../ui/primitives';
import { styles } from './auth.styles';
import { noticeStyles } from '../../ui/notice.styles';
import type { AppContext, WechatLoginError } from '../../app/context';

const WECHAT_ERROR_TEXT: Record<WechatLoginError, string> = {
  wechat_failed: '微信登录未完成，请重试。',
  wechat_unavailable: '微信登录暂时不可用，请稍后再试。',
};

/**
 * The login entry the server bounces the browser around. It is a full-document
 * hop (same origin, then the bridge), so the shared hono client — whose base is
 * relative and cannot build standalone URLs — does not apply here.
 */
const WECHAT_START_PATH = '/api/auth/wechat/start';

/** WeChat sign-in; an invitation in the URL survives the detour through the bridge. */
export function AuthView(props: { ctx: AppContext; error?: WechatLoginError; notice?: string }) {
  const navigate = useNavigate();
  const loginHref = () => {
    const roomId = props.ctx.pendingInvite();
    return roomId ? `${WECHAT_START_PATH}?room=${encodeURIComponent(roomId)}` : WECHAT_START_PATH;
  };

  return (
    <section data-testid="view-auth">
      <div class={stylex.props(ui.panel).className} aria-labelledby="auth-title">
        <Show when={props.notice}>
          {(sessionNotice) => (
            <div
              class={stylex.props(ui.notice, noticeStyles.warn).className}
              data-testid="session-notice"
              data-tone="warn"
            >
              {`⚠ ${sessionNotice()}`}
            </div>
          )}
        </Show>

        <Show when={props.ctx.pendingInvite()}>
          {(invite) => (
            <div
              class={stylex.props(ui.notice).className}
              data-testid="invite-notice"
              data-tone="info"
            >
              <span class={stylex.props(ui.noticeIcon).className}>✦</span>
              <div>
                <span data-testid="invite-notice-text">登录后将自动加入房间 {invite()}。</span>
                <div class={stylex.props(ui.buttonRow, noticeStyles.actions).className}>
                  <button
                    class={stylex.props(ui.button, ui.small, ui.gold).className}
                    type="button"
                    data-testid="invite-continue-home"
                    onClick={() => void navigate({ to: '/', search: {} })}
                  >
                    稍后加入，先去首页
                  </button>
                </div>
              </div>
            </div>
          )}
        </Show>

        <div class={stylex.props(ui.panelHead).className}>
          <h1
            class={stylex.props(ui.title, styles.title).className}
            id="auth-title"
            data-testid="auth-title"
          >
            登录咒文对决
          </h1>
          <span class={stylex.props(ui.eyebrow).className}>准备好迎接下一场对决</span>
        </div>

        <Show when={props.error}>
          {(failure) => (
            <div
              class={stylex.props(ui.notice, noticeStyles.warn).className}
              data-testid="auth-error"
              data-tone="error"
              role="alert"
            >
              {`⚠ ${WECHAT_ERROR_TEXT[failure()]}`}
            </div>
          )}
        </Show>

        <p class={stylex.props(ui.muted, styles.paragraph).className}>
          使用微信账号登录；登录状态会保留在此浏览器中。
        </p>

        <a
          class={stylex.props(ui.button, ui.primary, ui.block, styles.link).className}
          href={loginHref()}
          data-testid="auth-wechat"
        >
          微信登录
        </a>
        <span class={stylex.props(ui.hint).className}>将前往微信完成登录，随后自动返回。</span>

        <div class={stylex.props(ui.buttonRow, styles.actionsSpaced).className}>
          <button
            class={stylex.props(ui.button, ui.ghost).className}
            type="button"
            data-testid="auth-back"
            onClick={() => void navigate({ to: '/', search: {} })}
          >
            返回首页
          </button>
        </div>
      </div>

      <div class={stylex.props(ui.panel).className}>
        <h2 class={stylex.props(ui.title, styles.h2Size).className}>为什么需要账号</h2>
        <p class={stylex.props(ui.muted, styles.paragraph).className}>
          登录后即可参与对战，保存战绩、打字速度与准确率。
        </p>
      </div>
    </section>
  );
}
