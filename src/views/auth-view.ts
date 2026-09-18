import { api, ApiError } from '../api';
import { el, setText } from '../dom';
import { messageOf, toast } from '../toast';
import { validatePassword, validateUsername } from '../validate';
import type { AppContext, AuthMode, View } from '../context';

/** Sign in or register; an invitation in the URL survives the detour. */
export class AuthView implements View {
  readonly el: HTMLElement;
  private readonly username: HTMLInputElement;
  private readonly password: HTMLInputElement;
  private readonly submit: HTMLButtonElement;
  private readonly loginTab: HTMLButtonElement;
  private readonly registerTab: HTMLButtonElement;
  private readonly formError: HTMLElement;
  private readonly title: HTMLElement;
  private readonly inviteText: HTMLElement;
  private readonly inviteNotice: HTMLElement;
  private readonly inviteButton: HTMLButtonElement;
  private readonly sessionNotice: HTMLElement;
  private mode: AuthMode;

  constructor(
    private readonly ctx: AppContext,
    initialMode: AuthMode = 'login',
    sessionNotice = '',
  ) {
    this.mode = initialMode;

    this.username = el('input', {
      type: 'text',
      id: 'auth-username',
      testid: 'auth-username',
      attrs: {
        autocomplete: 'username',
        spellcheck: 'false',
        maxlength: '20',
        required: true,
      },
    });
    this.password = el('input', {
      type: 'password',
      id: 'auth-password',
      testid: 'auth-password',
      attrs: { autocomplete: 'current-password', maxlength: '128', required: true },
    });

    this.loginTab = el('button', {
      class: 'chip',
      type: 'button',
      testid: 'auth-mode-login',
      text: '登录',
      attrs: { 'aria-pressed': 'true' },
      on: { click: () => this.setMode('login') },
    });
    this.registerTab = el('button', {
      class: 'chip',
      type: 'button',
      testid: 'auth-mode-register',
      text: '注册新账号',
      attrs: { 'aria-pressed': 'false' },
      on: { click: () => this.setMode('register') },
    });

    this.formError = el('p', {
      class: 'small',
      testid: 'auth-error',
      data: { tone: 'error' },
      hidden: true,
    });

    this.submit = el('button', {
      class: 'btn btn--primary btn--block',
      type: 'submit',
      testid: 'auth-submit',
      text: '登录',
    });

    this.inviteButton = el('button', {
      class: 'btn btn--small btn--gold',
      type: 'button',
      testid: 'invite-continue-home',
      text: '稍后加入，先去首页',
      on: {
        click: () => {
          this.ctx.goHome();
        },
      },
    });
    this.inviteText = el('span', { testid: 'invite-notice-text', text: '' });
    this.inviteNotice = el(
      'div',
      { class: 'notice', testid: 'invite-notice', data: { tone: 'info' }, hidden: true },
      el('span', { class: 'notice__icon', text: '✦' }),
      el(
        'div',
        {},
        this.inviteText,
        el(
          'div',
          { class: 'btn-row', attrs: { style: 'margin-top:8px' } },
          this.inviteButton,
        ),
      ),
    );

    this.sessionNotice = el('div', {
      class: 'notice',
      testid: 'session-notice',
      data: { tone: 'warn' },
      hidden: true,
    });
    if (sessionNotice) {
      setText(this.sessionNotice, `⚠ ${sessionNotice}`);
      this.sessionNotice.hidden = false;
    }

    this.title = el('h1', { id: 'auth-title', testid: 'auth-title', text: '登录咒文对决' });
    const form = el(
      'form',
      {
        class: 'panel',
        testid: 'auth-form',
        attrs: { novalidate: true, 'aria-labelledby': 'auth-title' },
        on: {
          submit: (event) => {
            event.preventDefault();
            void this.submitCredentials();
          },
        },
      },
      this.sessionNotice,
      this.inviteNotice,
      el(
        'div',
        { class: 'panel__head' },
        this.title,
        el('span', { class: 'panel__eyebrow', text: '准备好迎接下一场对决' }),
      ),
      el('div', { class: 'chips', attrs: { style: 'margin-bottom:14px' } }, this.loginTab, this.registerTab),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', attrs: { for: 'auth-username' }, text: '用户名' }),
        this.username,
        el('span', {
          class: 'field__hint',
          text: '2–20 个字符，支持中文、英文字母、数字和下划线。',
        }),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { class: 'field__label', attrs: { for: 'auth-password' }, text: '密码' }),
        this.password,
        el('span', { class: 'field__hint', text: '10–128 个字符，区分大小写。' }),
      ),
      this.formError,
      this.submit,
    );

    this.el = el(
      'section',
      { testid: 'view-auth' },
      form,
      el(
        'div',
        { class: 'panel' },
        el('h2', { text: '为什么需要账号' }),
        el('p', {
          class: 'muted',
          text: '登录后即可参与对战，保存战绩、打字速度与准确率。',
        }),
        el(
          'div',
          { class: 'btn-row' },
          el('button', {
            class: 'btn btn--ghost',
            type: 'button',
            testid: 'auth-back',
            text: '返回首页',
            on: { click: () => this.ctx.goHome() },
          }),
        ),
      ),
    );

    this.applyMode();
    this.update();
  }

  update(): void {
    const invite = this.ctx.pendingInvite();
    this.inviteNotice.hidden = !invite;
    if (invite) {
      setText(this.inviteText, `登录或注册后将自动加入房间 ${invite}。`);
    }
  }

  destroy(): void {
    this.el.remove();
  }

  private setMode(mode: AuthMode): void {
    this.mode = mode;
    this.applyMode();
  }

  private applyMode(): void {
    const registering = this.mode === 'register';
    this.loginTab.setAttribute('aria-pressed', String(!registering));
    this.registerTab.setAttribute('aria-pressed', String(registering));
    this.submit.textContent = registering ? '注册并进入' : '登录';
    this.password.setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
    setText(this.title, registering ? '注册咒文对决' : '登录咒文对决');
  }

  private async submitCredentials(): Promise<void> {
    const username = this.username.value.trim();
    const password = this.password.value;

    const usernameCheck = validateUsername(username);
    if (!usernameCheck.ok) {
      this.showError(usernameCheck.message);
      this.username.focus();
      return;
    }
    const passwordCheck = validatePassword(password);
    if (!passwordCheck.ok) {
      this.showError(passwordCheck.message);
      this.password.focus();
      return;
    }

    this.submit.disabled = true;
    const original = this.submit.textContent ?? '';
    this.submit.textContent = this.mode === 'register' ? '注册中…' : '登录中…';
    this.hideError();

    try {
      const response =
        this.mode === 'register'
          ? await api.register(username, password)
          : await api.login(username, password);
      this.ctx.session.setUser(response.user);
      toast(`欢迎，${response.user.username}。`, 'good');
      const invite = this.ctx.pendingInvite();
      if (invite) {
        this.ctx.openRoom(invite);
      } else {
        this.ctx.goHome();
      }
    } catch (error) {
      const message = messageOf(
        error,
        this.mode === 'register' ? '注册失败，请稍后重试。' : '登录失败，请稍后重试。',
      );
      this.showError(message);
      toast(message, 'error');
      if (error instanceof ApiError && error.status === 409 && this.mode === 'register') {
        this.setMode('login');
      }
    } finally {
      this.submit.disabled = false;
      this.submit.textContent = original;
    }
  }

  private showError(message: string): void {
    setText(this.formError, message);
    this.formError.hidden = false;
  }

  private hideError(): void {
    this.formError.hidden = true;
  }
}
