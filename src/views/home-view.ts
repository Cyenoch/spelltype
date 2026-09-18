import { DIFFICULTIES, DIFFICULTY_HINTS, DIFFICULTY_LABELS, ELEMENTS, formatTimestamp } from '../format';
import { ASSETS } from '../assets';
import { api, ApiError } from '../api';
import { el, setData, setText } from '../dom';
import { messageOf } from '../toast';
import type { AppContext, View } from '../context';
import type { Difficulty, Profile } from '../../shared/protocol';
import './home.css';

/** The game entrance: match controls, account summary and a short primer. */
export class HomeView implements View {
  readonly el: HTMLElement;
  /** Kept mounted so availability remains observable even when hidden. */
  private readonly aiNotice: HTMLElement;
  private readonly inviteNotice: HTMLElement;
  private readonly inviteText: HTMLElement;
  private readonly difficultySelect: HTMLSelectElement;
  private readonly difficultyHint: HTMLElement;
  /** Signed-in card and guest card: exactly one is visible, so neither action is duplicated. */
  private readonly signedBlock: HTMLElement;
  private readonly guestBlock: HTMLElement;
  private readonly playerName: HTMLElement;
  private readonly statsGrid: HTMLElement;
  private readonly games: HTMLElement;
  private readonly wins: HTMLElement;
  private readonly bestCpm: HTMLElement;
  private readonly recent: HTMLElement;
  private readonly statsNote: HTMLElement;
  private readonly statsRetry: HTMLButtonElement;
  /** Account whose record the card shows or is fetching; null for a guest. */
  private statsFor: string | null = null;
  private destroyed = false;

  constructor(private readonly ctx: AppContext) {
    this.aiNotice = el('div', {
      class: 'notice',
      testid: 'home-ai-notice',
      data: { tone: 'warn', state: 'configured' },
      hidden: true,
    });

    this.inviteText = el('span', { text: '' });
    this.inviteNotice = el(
      'div',
      { class: 'notice', testid: 'home-invite-notice', data: { tone: 'info' }, hidden: true },
      el('span', { class: 'notice__icon', text: '✦' }),
      el(
        'div',
        {},
        this.inviteText,
        el(
          'div',
          { class: 'btn-row', attrs: { style: 'margin-top:8px' } },
          el('button', {
            class: 'btn btn--small btn--gold',
            type: 'button',
            testid: 'home-join-invite',
            text: '进入邀请的房间',
            on: { click: () => this.joinInvite() },
          }),
          el('button', {
            class: 'btn btn--small btn--ghost',
            type: 'button',
            testid: 'home-dismiss-invite',
            text: '忽略邀请',
            on: {
              click: () => {
                this.ctx.setPendingInvite(null);
                this.ctx.goHome();
              },
            },
          }),
        ),
      ),
    );

    this.difficultySelect = el('select', {
      id: 'home-difficulty',
      testid: 'home-quick-difficulty',
      attrs: { 'aria-describedby': 'quick-difficulty-hint' },
    });
    for (const difficulty of DIFFICULTIES) {
      this.difficultySelect.appendChild(
        el('option', {
          value: difficulty,
          text: DIFFICULTY_LABELS[difficulty],
        }),
      );
    }
    this.difficultySelect.value = 'normal';
    this.difficultyHint = el('span', {
      class: 'field__hint',
      id: 'quick-difficulty-hint',
      text: DIFFICULTY_HINTS.normal,
    });
    this.difficultySelect.addEventListener('change', () => {
      const value = this.difficultySelect.value as Difficulty;
      setText(this.difficultyHint, DIFFICULTY_HINTS[value]);
      setData(this.difficultySelect, 'difficulty', value);
    });
    setData(this.difficultySelect, 'difficulty', 'normal');

    const quickButton = el('button', {
      class: 'btn btn--primary btn--hero btn--block',
      type: 'button',
      testid: 'home-quick-start',
      text: '快速匹配 · 1v1',
      on: { click: () => this.startQuick() },
    });
    const createButton = el('button', {
      class: 'btn btn--hero btn--block',
      type: 'button',
      testid: 'home-create',
      text: '创建私人房 · 2–4 人',
      on: { click: () => this.requireAuth(() => this.ctx.goCreate()) },
    });
    const authButton = el('button', {
      class: 'btn btn--primary',
      type: 'button',
      testid: 'home-auth',
      text: '登录 / 注册',
      on: { click: () => this.ctx.goAuth('login') },
    });
    const profileButton = el('button', {
      class: 'btn',
      type: 'button',
      testid: 'home-profile',
      text: '我的战绩',
      on: { click: () => this.requireAuth(() => this.ctx.goProfile()) },
    });

    this.playerName = el('div', { class: 'pc__name', testid: 'home-username', text: '' });
    this.games = el('b', { class: 'pc__stat-value', testid: 'home-games', text: '—' });
    this.wins = el('b', { class: 'pc__stat-value', testid: 'home-wins', text: '—' });
    this.bestCpm = el('b', { class: 'pc__stat-value', testid: 'home-best-cpm', text: '—' });
    this.statsGrid = el(
      'div',
      { class: 'pc__stats', testid: 'home-stats', hidden: true },
      el(
        'div',
        { class: 'pc__stat' },
        el('span', { class: 'pc__stat-label', text: '完成对局' }),
        this.games,
      ),
      el('div', { class: 'pc__stat' }, el('span', { class: 'pc__stat-label', text: '胜场' }), this.wins),
      el(
        'div',
        { class: 'pc__stat' },
        el('span', { class: 'pc__stat-label', text: '最佳速度' }),
        el('div', { class: 'pc__stat-row' }, this.bestCpm, el('span', { class: 'pc__stat-unit', text: '字/分钟' })),
      ),
    );
    this.recent = el('p', { class: 'pc__recent', testid: 'home-recent', hidden: true });
    this.statsNote = el('p', { class: 'pc__note', testid: 'home-stats-note', hidden: true });
    this.statsRetry = el('button', {
      class: 'btn btn--small btn--quiet',
      type: 'button',
      testid: 'home-stats-retry',
      text: '重试',
      hidden: true,
      on: {
        click: () => {
          const user = this.ctx.session.user;
          if (user) void this.loadProfile(user.id);
        },
      },
    });

    this.signedBlock = el(
      'div',
      { class: 'pc' },
      el(
        'div',
        { class: 'pc__head' },
        el('img', { class: 'pc__avatar', attrs: { src: ASSETS.avatars[0], alt: '', width: 56, height: 56 } }),
        el(
          'div',
          { class: 'pc__id' },
          this.playerName,
          el('div', { class: 'pc__sub', text: '准备迎接下一场对决' }),
        ),
      ),
      this.statsGrid,
      this.recent,
      this.statsNote,
      el('div', { class: 'btn-row' }, profileButton, this.statsRetry),
    );

    this.guestBlock = el(
      'div',
      { class: 'pc pc--guest' },
      el(
        'div',
        { class: 'pc__head' },
        el('img', {
          class: 'pc__avatar pc__avatar--guest',
          attrs: { src: ASSETS.avatars[0], alt: '', width: 56, height: 56 },
        }),
        el(
          'div',
          { class: 'pc__id' },
          el('div', { class: 'pc__name', text: '未登录' }),
          el('div', { class: 'pc__sub', text: '登录后可以快速匹配、创建私人房。' }),
        ),
      ),
      el('p', { class: 'pc__note', text: '注册账号，开启你的第一场对决。' }),
      el('div', { class: 'btn-row' }, authButton),
    );

    this.el = el(
      'section',
      { class: 'home', testid: 'view-home' },
      el(
        'div',
        { class: 'hero' },
        el('img', {
          class: 'hero__art',
          attrs: { src: ASSETS.arenas[0], alt: '', 'aria-hidden': 'true', decoding: 'async' },
        }),
        el(
          'div',
          { class: 'hero__layout' },
          el(
            'div',
            { class: 'hero__main' },
            el(
              'div',
              { class: 'hero__crest' },
              el('img', { attrs: { src: ASSETS.sigil, alt: '', width: 40, height: 40 } }),
              el('span', { class: 'hero__eyebrow', text: '连续咒文对决 · 2–4 人' }),
              el(
                'div',
                { class: 'hero__sigils', attrs: { 'aria-hidden': 'true' } },
                ...ELEMENTS.map((element) =>
                  el('img', { attrs: { src: ASSETS.elementGlyphs[element], alt: '', width: 20, height: 20 } }),
                ),
              ),
            ),
            el('h1', { class: 'hero__title', text: '咒文对决' }),
            el('p', { class: 'hero__lead', text: '以文字为咒，以速度决胜。' }),
            el(
              'div',
              { class: 'hero__facts' },
              el('div', { class: 'fact' }, el('b', { text: '2400' }), el('span', { text: '每人生命' })),
              el('div', { class: 'fact' }, el('b', { text: '240 秒' }), el('span', { text: '单局时长' })),
              el('div', { class: 'fact' }, el('b', { text: '×4' }), el('span', { text: '每字伤害' })),
              el('div', { class: 'fact' }, el('b', { text: '24 条' }), el('span', { text: '共享咒文' })),
            ),
            this.aiNotice,
            this.inviteNotice,
            el(
              'div',
              { class: 'home__entries' },
              el(
                'div',
                { class: 'entry entry--quick' },
                el(
                  'div',
                  { class: 'entry__head' },
                  el('h2', { class: 'entry__title', text: '快速匹配' }),
                  el('span', { class: 'entry__tag', text: '1v1' }),
                ),
                el('label', { class: 'field__label', attrs: { for: 'home-difficulty' }, text: '咒文难度' }),
                this.difficultySelect,
                this.difficultyHint,
                quickButton,
              ),
              el(
                'div',
                { class: 'entry entry--room' },
                el('h2', { class: 'entry__title', text: '私人房' }),
                el('p', { class: 'entry__note', text: '选一个咒文主题，把邀请链接发给朋友一起打。' }),
                el(
                  'div',
                  { class: 'entry__seats', attrs: { 'aria-hidden': 'true' } },
                  ...ASSETS.avatars.map((src) =>
                    el('img', { attrs: { src, alt: '', width: 28, height: 28, loading: 'lazy' } }),
                  ),
                ),
                createButton,
              ),
            ),
          ),
          el('aside', { class: 'hero__aside', testid: 'home-player' }, this.signedBlock, this.guestBlock),
        ),
      ),
      el(
        'section',
        { class: 'panel home__tutorial' },
        el(
          'div',
          { class: 'panel__head' },
          el('h2', { text: '三步上手' }),
          el('span', { class: 'panel__eyebrow', text: '1 分钟' }),
        ),
        el(
          'ol',
          { class: 'steps' },
          el('li', {}, '登录后快速匹配，或创建私人房把邀请链接发给朋友。'),
          el('li', {}, '快速匹配自动开战；私人房准备就绪后，由房主开始。'),
          el('li', {}, '打完一条咒文造成伤害，自动打向顺时针下一个还活着的人。'),
        ),
        el(
          'a',
          {
            class: 'home__guide',
            testid: 'home-guide-link',
            attrs: { href: '/guide' },
            on: { click: (event) => this.openGuide(event) },
          },
          el('span', { text: '完整教程：从开局到结算' }),
          el('span', { class: 'home__guide-arrow', attrs: { 'aria-hidden': 'true' }, text: '→' }),
        ),
      ),
    );
  }

  update(): void {
    const invite = this.ctx.pendingInvite();
    if (invite) {
      setText(this.inviteText, this.ctx.session.user ? '你收到了一份对战邀请。' : '你收到了一份对战邀请，登录后即可加入。');
      this.inviteNotice.hidden = false;
    } else {
      this.inviteNotice.hidden = true;
    }

    const configured = this.ctx.session.aiConfigured;
    setData(this.aiNotice, 'state', configured ? 'configured' : 'missing');
    this.aiNotice.hidden = configured;
    if (!configured) {
      setText(
        this.aiNotice,
        '咒文服务暂不可用。你仍可匹配或建房，请稍后再开始对决。',
      );
    }

    // Session-dependent chrome is re-derived here so a card built while signed
    // in cannot keep showing that account's record after a logout.
    const user = this.ctx.session.user;
    this.signedBlock.hidden = !user;
    this.guestBlock.hidden = Boolean(user);
    if (!user) {
      this.statsFor = null;
      this.resetStats();
      return;
    }
    setText(this.playerName, user.username);
    if (this.statsFor !== user.id) void this.loadProfile(user.id);
  }

  destroy(): void {
    this.destroyed = true;
    this.el.remove();
  }

  /** Plain clicks stay in the app; modified clicks keep the browser's own tab/window behaviour. */
  private openGuide(event: MouseEvent): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    this.ctx.goGuide();
  }

  private startQuick(): void {
    this.requireAuth(() => {
      const difficulty = (this.difficultySelect.value || 'normal') as Difficulty;
      this.ctx.goQueue(difficulty);
    });
  }

  private joinInvite(): void {
    const invite = this.ctx.pendingInvite();
    if (!invite) return;
    this.requireAuth(() => this.ctx.openRoom(invite));
  }

  private requireAuth(action: () => void): void {
    if (!this.ctx.session.user) {
      this.ctx.goAuth('login');
      return;
    }
    action();
  }

  private async loadProfile(userId: string): Promise<void> {
    this.statsFor = userId;
    this.resetStats();
    this.showStatsNote('正在读取你的战绩…');

    try {
      const profile = await api.profile();
      // A response may only touch the DOM while this view is still mounted for
      // the same account: a logout, a different sign-in or a view change in the
      // meantime makes the answer worthless, and `destroyed` also keeps a late
      // auth failure from writing into a view that already left.
      if (this.destroyed || this.ctx.session.user?.id !== userId) return;
      this.renderProfile(profile);
    } catch (error) {
      if (this.destroyed || this.ctx.session.user?.id !== userId) return;
      if (error instanceof ApiError && error.isAuthFailure) {
        this.ctx.handleAuthFailure('登录已过期，请重新登录。');
        return;
      }
      this.showStatsNote(messageOf(error, '读取战绩失败，请稍后重试。'), 'error');
      this.statsRetry.hidden = false;
    }
  }

  private renderProfile(profile: Profile): void {
    const { stats, history } = profile;
    setText(this.games, String(stats.games));
    setText(this.wins, String(stats.wins));
    setText(this.bestCpm, stats.games === 0 ? '—' : String(stats.bestCpm));
    this.statsGrid.hidden = false;

    if (stats.games === 0) {
      this.showStatsNote('第一场对决，从这里开始。');
      return;
    }

    this.statsNote.hidden = true;
    const latest = history[0];
    if (!latest) return;
    setText(this.recent, `最近一局：${latest.theme} · 第 ${latest.rank} 名 · ${latest.cpm} 字/分钟`);
    this.recent.title = `完成于 ${formatTimestamp(latest.created_at)}`;
    this.recent.hidden = false;
  }

  private resetStats(): void {
    this.statsGrid.hidden = true;
    this.recent.hidden = true;
    this.statsNote.hidden = true;
    this.statsRetry.hidden = true;
  }

  private showStatsNote(text: string, tone: 'muted' | 'error' = 'muted'): void {
    setText(this.statsNote, text);
    setData(this.statsNote, 'tone', tone);
    this.statsNote.hidden = false;
  }
}
