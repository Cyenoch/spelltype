import { Show, createSignal } from 'solid-js';
import { useNavigate } from '@tanstack/solid-router';
import { createForm } from '@tanstack/solid-form';
import * as stylex from '@stylexjs/stylex';
import { loginSchema, registerSchema } from '../../../shared/validation';
import { parseResponse, DetailedError } from 'hono/client';
import { client } from '../../app/client';
import { messageOf, toast } from '../../ui/toast';
import { ui } from '../../ui/primitives';
import { styles } from './auth.styles';
import { noticeStyles } from '../../ui/notice.styles';
import type { AppContext, AuthMode } from '../../app/context';

type CredentialField = 'username' | 'password';

/**
 * The first problem a submission ran into, in field order. A schema reports
 * issues as objects; hand-written validators report plain strings.
 */
function firstIssueMessage(state: {
  readonly fieldMeta: Partial<Record<CredentialField, { readonly errors?: readonly unknown[] }>>;
}): string {
  const issues = [
    ...(state.fieldMeta.username?.errors ?? []),
    ...(state.fieldMeta.password?.errors ?? []),
  ];
  const first = issues[0];
  if (typeof first === 'string') return first;
  if (typeof first !== 'object' || first === null || !('message' in first)) return '';
  const { message } = first;
  return typeof message === 'string' ? message : '';
}

/** Sign in or register; an invitation in the URL survives the detour. */
export function AuthView(props: { ctx: AppContext; mode?: AuthMode; notice?: string }) {
  const navigate = useNavigate();
  const [mode, setMode] = createSignal<AuthMode>(props.mode ?? 'login');
  const [submitError, setSubmitError] = createSignal<string | null>(null);
  let usernameEl!: HTMLInputElement;
  let passwordEl!: HTMLInputElement;

  const registering = () => mode() === 'register';

  const form = createForm(() => ({
    defaultValues: { username: '', password: '' },
    validators: { onSubmit: registering() ? registerSchema : loginSchema },
    onSubmit: async ({ value }) => {
      setSubmitError(null);
      await authenticate(value.username.trim(), value.password, registering());
    },
    onSubmitInvalid: ({ formApi }) => {
      setSubmitError(null);
      const usernameFailed = (formApi.getFieldMeta('username')?.errors ?? []).length > 0;
      (usernameFailed ? usernameEl : passwordEl).focus();
    },
  }));

  /**
   * Each mode validates against its own schema, so switching drops the other
   * schema's issues: the next submit is judged afresh instead of being blocked
   * by an error the new rules would not produce.
   */
  const switchMode = (next: AuthMode) => {
    if (next === mode()) return;
    setMode(next);
    setSubmitError(null);
    for (const field of ['username', 'password'] as const) {
      const meta = form.getFieldMeta(field);
      if (meta) form.setFieldMeta(field, { ...meta, errorMap: {} });
    }
  };

  const authenticate = async (username: string, password: string, register: boolean) => {
    try {
      const response = register
        ? await parseResponse(client.api.register.$post({ json: { username, password } }))
        : await parseResponse(client.api.login.$post({ json: { username, password } }));
      // The shell's session is query-backed, so `setUser` publishes the new identity
      // into the session query and drops the previous account's cached data.
      props.ctx.session.setUser(response.user);
      toast(`欢迎，${response.user.username}。`, 'good');
      const invite = props.ctx.pendingInvite();
      if (invite) {
        props.ctx.setPendingInvite(invite);
        void navigate({ to: '/', search: { room: invite } });
      } else {
        void navigate({ to: '/', search: {} });
      }
    } catch (failure) {
      const message = messageOf(
        failure,
        register ? '注册失败，请稍后重试。' : '登录失败，请稍后重试。',
      );
      toast(message, 'error');
      // A duplicate account means the visitor wants to sign in after all; the
      // conflict message is raised again afterwards so it survives the switch.
      if (failure instanceof DetailedError && failure.statusCode === 409 && register)
        switchMode('login');
      setSubmitError(message);
    }
  };

  return (
    <section data-testid="view-auth">
      <form
        class={stylex.props(ui.panel).className}
        data-testid="auth-form"
        novalidate
        aria-labelledby="auth-title"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
      >
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
                <span data-testid="invite-notice-text">
                  登录或注册后将自动加入房间 {invite()}。
                </span>
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
            {registering() ? '注册咒文对决' : '登录咒文对决'}
          </h1>
          <span class={stylex.props(ui.eyebrow).className}>准备好迎接下一场对决</span>
        </div>

        <div class={stylex.props(ui.chips, styles.chipsSpaced).className}>
          <button
            class={stylex.props(ui.chip, registering() ? null : ui.chipSelected).className}
            type="button"
            data-testid="auth-mode-login"
            aria-pressed={!registering()}
            onClick={() => switchMode('login')}
          >
            登录
          </button>
          <button
            class={stylex.props(ui.chip, registering() ? ui.chipSelected : null).className}
            type="button"
            data-testid="auth-mode-register"
            aria-pressed={registering()}
            onClick={() => switchMode('register')}
          >
            注册新账号
          </button>
        </div>

        <div class={stylex.props(ui.field).className}>
          <label class={stylex.props(ui.label).className} for="auth-username">
            用户名
          </label>
          <form.Field name="username">
            {(field) => (
              <input
                ref={(el) => {
                  usernameEl = el;
                }}
                class={stylex.props(ui.input).className}
                type="text"
                id="auth-username"
                data-testid="auth-username"
                autocomplete="username"
                spellcheck={false}
                maxlength="20"
                required
                value={field().state.value}
                onInput={(event) => field().handleChange(event.currentTarget.value)}
                onBlur={() => field().handleBlur()}
              />
            )}
          </form.Field>
          <span class={stylex.props(ui.hint).className}>
            2–20 个字符，支持中文、英文字母、数字和下划线。
          </span>
        </div>

        <div class={stylex.props(ui.field).className}>
          <label class={stylex.props(ui.label).className} for="auth-password">
            密码
          </label>
          <form.Field name="password">
            {(field) => (
              <input
                ref={(el) => {
                  passwordEl = el;
                }}
                class={stylex.props(ui.input).className}
                type="password"
                id="auth-password"
                data-testid="auth-password"
                autocomplete={registering() ? 'new-password' : 'current-password'}
                maxlength="128"
                required
                value={field().state.value}
                onInput={(event) => field().handleChange(event.currentTarget.value)}
                onBlur={() => field().handleBlur()}
              />
            )}
          </form.Field>
          <span class={stylex.props(ui.hint).className}>10–128 个字符，区分大小写。</span>
        </div>

        <form.Subscribe selector={firstIssueMessage}>
          {(validationMessage) => (
            <Show when={submitError() ?? validationMessage()}>
              {(failure) => (
                <p
                  class={stylex.props(ui.smallText).className}
                  data-testid="auth-error"
                  data-tone="error"
                >
                  {failure()}
                </p>
              )}
            </Show>
          )}
        </form.Subscribe>

        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <button
              class={stylex.props(ui.button, ui.primary, ui.block).className}
              type="submit"
              data-testid="auth-submit"
              disabled={submitting()}
            >
              {submitting()
                ? registering()
                  ? '注册中…'
                  : '登录中…'
                : registering()
                  ? '注册并进入'
                  : '登录'}
            </button>
          )}
        </form.Subscribe>
      </form>

      <div class={stylex.props(ui.panel).className}>
        <h2 class={stylex.props(ui.title, styles.h2Size).className}>为什么需要账号</h2>
        <p class={stylex.props(ui.muted, styles.paragraph).className}>
          登录后即可参与对战，保存战绩、打字速度与准确率。
        </p>
        <div class={stylex.props(ui.buttonRow).className}>
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
    </section>
  );
}
