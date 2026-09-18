import type { MatchResult } from '../../shared/protocol';
import { api, ApiError } from '../api';
import { append, clear, el, setText } from '../dom';
import { formatAccuracyPercent, formatDuration, formatTimestamp } from '../format';
import { messageOf } from '../toast';
import type { AppContext, View } from '../context';

/**
 * Account summary: totals, best CPM and the ten most recent matches. History is
 * continuous-combat only: every row is a damage/health/casts/CPM/accuracy
 * record, with nothing carried over from the retired round game.
 */
export class ProfileView implements View {
  readonly el: HTMLElement;
  private readonly games: HTMLElement;
  private readonly wins: HTMLElement;
  private readonly bestCpm: HTMLElement;
  private readonly historyBody: HTMLElement;
  private readonly error: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly refresh: HTMLButtonElement;

  constructor(private readonly ctx: AppContext) {
    this.games = el('div', { class: 'tile__value', testid: 'profile-games', text: '—' });
    this.wins = el('div', { class: 'tile__value', testid: 'profile-wins', text: '—' });
    this.bestCpm = el('div', { class: 'tile__value', testid: 'profile-best-cpm', text: '—' });
    this.historyBody = el('tbody');
    this.error = el('p', { class: 'small', testid: 'profile-error', hidden: true });
    this.loading = el('p', { class: 'small muted', testid: 'profile-loading', text: '正在读取战绩…' });
    this.refresh = el('button', {
      class: 'btn btn--small',
      type: 'button',
      testid: 'profile-refresh',
      text: '刷新',
      on: { click: () => void this.load() },
    });

    this.el = el(
      'section',
      { testid: 'view-profile' },
      el(
        'div',
        { class: 'panel' },
        el('div', { class: 'panel__head' }, el('h1', { text: '我的战绩' }), this.refresh),
        el(
          'div',
          { class: 'stat-tiles', testid: 'profile-stats' },
          el('div', { class: 'tile' }, el('div', { class: 'tile__label', text: '完成对局' }), this.games),
          el('div', { class: 'tile' }, el('div', { class: 'tile__label', text: '胜场（第 1 名）' }), this.wins),
          el(
            'div',
            { class: 'tile' },
            el('div', { class: 'tile__label', text: '最佳速度 · 字/分钟' }),
            this.bestCpm,
          ),
        ),
        el('p', {
          class: 'small faint',
          text: '只记录已完成的对局，并列第一也计入胜场。',
        }),
        this.loading,
        this.error,
      ),
      el(
        'div',
        { class: 'panel' },
        el('h2', { text: '最近十场' }),
        el(
          'div',
          { class: 'results__wrap' },
          el(
            'table',
            { class: 'results__table', testid: 'profile-history' },
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                el('th', { text: '时间' }),
                el('th', { text: '主题' }),
                el('th', { class: 'num', text: '名次' }),
                el('th', { class: 'num', text: '造成伤害' }),
                el('th', { class: 'num', text: '剩余生命' }),
                el('th', { class: 'num', text: '施法' }),
                el('th', { class: 'num', text: '字/分钟' }),
                el('th', { class: 'num', text: '准确率' }),
              ),
            ),
            this.historyBody,
          ),
        ),
      ),
      el(
        'div',
        { class: 'panel' },
        el(
          'div',
          { class: 'btn-row' },
          el('button', {
            class: 'btn',
            type: 'button',
            testid: 'profile-back',
            text: '返回首页',
            on: { click: () => this.ctx.goHome() },
          }),
          el('button', {
            class: 'btn btn--ghost',
            type: 'button',
            testid: 'profile-signout',
            text: '退出登录',
            on: { click: () => void this.signOut() },
          }),
        ),
      ),
    );
  }

  update(): void {
    void this.load();
  }

  destroy(): void {
    this.el.remove();
  }

  private async load(): Promise<void> {
    this.loading.hidden = false;
    this.error.hidden = true;
    this.refresh.disabled = true;
    try {
      const profile = await api.profile();
      setText(this.games, String(profile.stats.games));
      setText(this.wins, String(profile.stats.wins));
      setText(this.bestCpm, String(profile.stats.bestCpm));
      this.renderHistory(profile.history);
    } catch (error) {
      if (error instanceof ApiError && error.isAuthFailure) {
        this.ctx.handleAuthFailure('登录已过期，请重新登录。');
        return;
      }
      setText(this.error, messageOf(error, '读取战绩失败，请稍后重试。'));
      this.error.hidden = false;
    } finally {
      this.loading.hidden = true;
      this.refresh.disabled = false;
    }
  }

  private renderHistory(history: MatchResult[]): void {
    clear(this.historyBody);
    if (history.length === 0) {
      append(this.historyBody, [
        el(
          'tr',
          {},
          el('td', {
            class: 'muted',
            attrs: { colspan: '8' },
            text: '还没有已保存的对局，先去打一局吧。',
          }),
        ),
      ]);
      return;
    }
    for (const result of history) {
      append(this.historyBody, [
        el(
          'tr',
          {
            testid: 'history-row',
            data: { 'match-id': result.match_id },
            // The two remaining measured columns, without a tenth table column.
            title: `战斗时长 ${formatDuration(result.duration_ms)} · 正确字符 ${result.correct_chars}`,
          },
          el('td', { testid: 'history-created', text: formatTimestamp(result.created_at) }),
          el('td', { testid: 'history-theme', text: result.theme }),
          el('td', { class: 'num', testid: 'history-rank', text: `#${result.rank}` }),
          el('td', {
            class: 'num',
            testid: 'history-damage',
            data: { damage: result.damage_dealt },
            text: String(result.damage_dealt),
          }),
          el('td', {
            class: 'num',
            testid: 'history-hp',
            data: { hp: result.hp_remaining },
            text: String(result.hp_remaining),
          }),
          el('td', { class: 'num', testid: 'history-spells', text: String(result.spells_cast) }),
          el('td', { class: 'num', testid: 'history-cpm', text: String(result.cpm) }),
          el('td', {
            class: 'num',
            testid: 'history-accuracy',
            text: formatAccuracyPercent(result.accuracy),
          }),
        ),
      ]);
    }
  }

  private async signOut(): Promise<void> {
    try {
      await api.logout();
    } catch (error) {
      if (!(error instanceof ApiError && error.isAuthFailure)) {
        this.ctx.notify(messageOf(error, '退出登录失败，请重试。'), 'error');
        return;
      }
    }
    this.ctx.session.clear();
    this.ctx.setPendingInvite(null);
    this.ctx.notify('已退出登录。', 'info');
    this.ctx.goHome();
  }
}
