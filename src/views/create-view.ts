import type { Difficulty } from '../../shared/protocol';
import { MAX_THEME_CHARS } from '../../shared/protocol';
import { DIFFICULTIES, DIFFICULTY_HINTS, DIFFICULTY_LABELS } from '../format';
import { THEME_PRESETS } from '../assets';
import { api, ApiError } from '../api';
import { el, setData, setText } from '../dom';
import { messageOf, toast } from '../toast';
import type { AppContext, View } from '../context';

/** Create a private room: preset or custom theme, difficulty, invite link. */
export class CreateRoomView implements View {
  readonly el: HTMLElement;
  private readonly themeInput: HTMLInputElement;
  private readonly counter: HTMLElement;
  private readonly difficultySelect: HTMLSelectElement;
  private readonly submit: HTMLButtonElement;
  private readonly error: HTMLElement;
  private readonly aiNotice: HTMLElement;
  private selectedPreset = '';

  constructor(private readonly ctx: AppContext) {
    this.themeInput = el('input', {
      type: 'text',
      id: 'room-theme',
      testid: 'room-theme-input',
      attrs: {
        maxlength: String(MAX_THEME_CHARS),
        placeholder: '例如：深夜图书馆的禁书目录',
        'aria-describedby': 'room-theme-counter',
        spellcheck: 'false',
      },
      on: {
        input: () => {
          this.selectedPreset = '';
          this.syncPresetState();
          this.updateCounter();
        },
      },
    });

    this.counter = el('span', {
      class: 'field__hint',
      id: 'room-theme-counter',
      testid: 'room-theme-counter',
      text: `0 / ${MAX_THEME_CHARS}`,
    });

    const presetRow = el('div', { class: 'chips', attrs: { style: 'margin-bottom:10px' } });
    for (const preset of THEME_PRESETS) {
      presetRow.appendChild(
        el('button', {
          class: 'chip',
          type: 'button',
          testid: 'theme-preset',
          data: { theme: preset.theme, preset: preset.id },
          text: preset.label,
          attrs: { 'aria-pressed': 'false' },
          on: {
            click: () => {
              this.themeInput.value = preset.theme;
              this.selectedPreset = preset.id;
              this.syncPresetState();
              this.updateCounter();
              this.themeInput.focus();
            },
          },
        }),
      );
    }

    this.difficultySelect = el(
      'select',
      { id: 'room-difficulty', testid: 'room-difficulty' },
      ...DIFFICULTIES.map((difficulty) =>
        el('option', { value: difficulty, text: `${DIFFICULTY_LABELS[difficulty]} · ${DIFFICULTY_HINTS[difficulty]}` }),
      ),
    );
    this.difficultySelect.value = 'normal';

    this.submit = el('button', {
      class: 'btn btn--primary',
      type: 'button',
      testid: 'room-create-submit',
      text: '创建房间并生成邀请链接',
      on: { click: () => void this.create() },
    });
    this.error = el('p', { class: 'small', testid: 'create-error', data: { tone: 'error' }, hidden: true });
    this.aiNotice = el('div', {
      class: 'notice',
      testid: 'create-ai-notice',
      data: { tone: 'warn' },
      hidden: true,
    });

    this.el = el(
      'section',
      { testid: 'view-create' },
      el(
        'div',
        { class: 'panel' },
        el(
          'div',
          { class: 'panel__head' },
          el('h1', { text: '创建私人房' }),
          el('span', { class: 'panel__eyebrow', text: '2–4 人' }),
        ),
        el('p', {
          class: 'muted',
          text: '选一个咒文主题，邀请朋友来一场对决。',
        }),
        this.aiNotice,
        el('hr', { class: 'rule' }),
        el('h3', { text: '主题' }),
        presetRow,
        el('label', { class: 'field__label', attrs: { for: 'room-theme' }, text: '自定义主题描述' }),
        this.themeInput,
        this.counter,
        el('h3', { attrs: { style: 'margin-top:18px' }, text: '难度' }),
        el('label', { class: 'field__label', attrs: { for: 'room-difficulty' }, text: '文本长度' }),
        this.difficultySelect,
        this.error,
        el(
          'div',
          { class: 'btn-row', attrs: { style: 'margin-top:16px' } },
          this.submit,
          el('button', {
            class: 'btn btn--ghost',
            type: 'button',
            testid: 'create-back',
            text: '返回首页',
            on: { click: () => this.ctx.goHome() },
          }),
        ),
      ),
      el(
        'div',
        { class: 'panel' },
        el('h2', { text: '接下来的流程' }),
        el(
          'ol',
          { class: 'steps' },
          el('li', {}, '创建后进入房间大厅，把邀请链接发给朋友（2–4 人都可以）。'),
          el('li', {}, '全员准备后，由房主开始对决。'),
          el('li', {}, '咒文准备就绪后进入战斗，等待不计入对战时间。'),
          el('li', {}, '开场倒数 3 秒后进入 240 秒连续战斗：完成咒文造成伤害，生命归零出局。'),
        ),
      ),
    );
    this.updateCounter();
  }

  update(): void {
    const configured = this.ctx.session.aiConfigured;
    this.aiNotice.hidden = configured;
    if (!configured) {
      setText(
        this.aiNotice,
        '咒文服务暂不可用。你仍可邀请朋友进入房间，请稍后再开始对决。',
      );
    }
  }

  destroy(): void {
    this.el.remove();
  }

  private syncPresetState(): void {
    for (const node of this.el.querySelectorAll<HTMLButtonElement>('[data-testid="theme-preset"]')) {
      node.setAttribute('aria-pressed', String(node.dataset.preset === this.selectedPreset));
    }
  }

  private updateCounter(): void {
    const length = [...this.themeInput.value].length;
    setText(this.counter, `${length} / ${MAX_THEME_CHARS}`);
    setData(this.counter, 'over', length > MAX_THEME_CHARS);
    if (length > MAX_THEME_CHARS) {
      this.showError(`主题最多 ${MAX_THEME_CHARS} 个字符，请缩短后再创建。`);
    } else if (this.error.textContent?.startsWith('主题最多')) {
      this.hideError();
    }
  }

  private async create(): Promise<void> {
    const theme = this.themeInput.value.trim();
    const length = [...theme].length;
    if (length === 0) {
      this.showError('请填写主题，或选择一个预设主题。');
      this.themeInput.focus();
      return;
    }
    if (length > MAX_THEME_CHARS) {
      this.showError(`主题最多 ${MAX_THEME_CHARS} 个字符，当前 ${length} 个。`);
      return;
    }

    const difficulty = (this.difficultySelect.value || 'normal') as Difficulty;
    this.submit.disabled = true;
    this.submit.textContent = '正在创建…';
    this.hideError();
    try {
      const { roomId } = await api.createRoom(theme, difficulty);
      toast('房间已创建，把邀请链接发给朋友吧。', 'good');
      this.ctx.setPendingInvite(roomId);
      this.ctx.openRoom(roomId);
    } catch (error) {
      if (error instanceof ApiError && error.isAuthFailure) {
        this.ctx.handleAuthFailure('登录已过期，请重新登录后再创建房间。');
        return;
      }
      this.showError(messageOf(error, '创建房间失败，请稍后重试。'));
      toast(messageOf(error, '创建房间失败。'), 'error');
    } finally {
      this.submit.disabled = false;
      this.submit.textContent = '创建房间并生成邀请链接';
    }
  }

  private showError(message: string): void {
    setText(this.error, message);
    this.error.hidden = false;
  }

  private hideError(): void {
    this.error.hidden = true;
  }
}
