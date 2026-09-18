import type { Difficulty, MatchTicket } from '../../shared/protocol';
import { api, ApiError } from '../api';
import { ASSETS } from '../assets';
import { el, setData, setText } from '../dom';
import { DIFFICULTY_HINTS, DIFFICULTY_LABELS, formatDuration } from '../format';
import { messageOf, toast } from '../toast';
import type { AppContext, View } from '../context';
import './queue.css';

const POLL_INTERVAL_MS = 2000;
const TICK_INTERVAL_MS = 250;

/** Where the search stands. Only `waiting` is a live search. */
type QueueState = 'waiting' | 'matched' | 'cancelled' | 'blocked';

const STATE_MESSAGES: Record<QueueState, string> = {
  waiting: '正在为你寻找同难度的对手…',
  matched: '已找到对手，正在进入房间…',
  cancelled: '已取消本次匹配。',
  blocked: '这次请求没能加入排队。',
};

const STATE_HINTS: Record<QueueState, string> = {
  waiting: '匹配成功后自动进入房间。',
  matched: '',
  cancelled: '可以重新排队，或返回首页。',
  blocked: '已有其他排队或对局。请取消已有排队，或返回原对局页面。',
};

const STATE_SELF_NOTES: Record<QueueState, string> = {
  waiting: '已进入排队',
  matched: '已配对',
  cancelled: '已退出排队',
  blocked: '未加入排队',
};

const STATE_RIVAL_NOTES: Record<QueueState, string> = {
  waiting: '尚未揭晓',
  matched: '已配对',
  cancelled: '本次匹配已结束',
  blocked: '本次匹配未开始',
};

/** Matchmaking status and controls; the only clock is actual elapsed waiting time. */
export class QueueView implements View {
  readonly el: HTMLElement;
  private readonly stateText: HTMLElement;
  private readonly elapsed: HTMLElement;
  private readonly difficultyText: HTMLElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly requeueButton: HTMLButtonElement;
  private readonly error: HTMLElement;
  private readonly errorText: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly selfNote: HTMLElement;
  private readonly rivalNote: HTMLElement;
  private timerId: number | null = null;
  private pollTimer: number | null = null;
  private startedAt = Date.now();
  private ticket: MatchTicket | null = null;
  private settled = false;
  private destroyed = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly difficulty: Difficulty,
  ) {
    const username = this.ctx.session.user?.username ?? '未登录';

    this.stateText = el('p', {
      class: 'queue__state',
      testid: 'queue-state',
      data: { state: 'waiting' },
      attrs: { 'aria-live': 'polite' },
      text: STATE_MESSAGES.waiting,
    });
    this.elapsed = el('div', {
      class: 'tile__value queue__elapsed',
      testid: 'queue-elapsed',
      text: formatDuration(0),
    });
    this.difficultyText = el('div', {
      class: 'tile__value',
      testid: 'queue-difficulty',
      text: DIFFICULTY_LABELS[difficulty],
    });
    this.selfNote = el('span', { class: 'duelist__note', text: STATE_SELF_NOTES.waiting });
    this.rivalNote = el('span', { class: 'duelist__note', text: STATE_RIVAL_NOTES.waiting });
    this.errorText = el('span');
    this.error = el(
      'div',
      { class: 'notice queue__error', testid: 'queue-error', data: { tone: 'error' }, hidden: true },
      el('span', { class: 'notice__icon', attrs: { 'aria-hidden': 'true' }, text: '✖' }),
      this.errorText,
    );
    this.hint = el('p', {
      class: 'queue__hint small faint',
      testid: 'queue-expiry',
      text: STATE_HINTS.waiting,
    });

    this.cancelButton = el('button', {
      class: 'btn btn--danger',
      type: 'button',
      testid: 'queue-cancel',
      text: '取消等待',
      on: { click: () => void this.cancel() },
    });
    this.requeueButton = el('button', {
      class: 'btn btn--primary',
      type: 'button',
      testid: 'queue-requeue',
      text: '重新排队',
      hidden: true,
      on: { click: () => this.requeue() },
    });

    const motionButton = el('button', {
      class: 'btn btn--small btn--ghost queue__motion',
      type: 'button',
      testid: 'queue-motion',
      text: '暂停动效',
      attrs: { 'aria-pressed': 'false' },
      on: {
        click: () => {
          const paused = this.el.dataset.motion !== 'paused';
          setData(this.el, 'motion', paused ? 'paused' : 'full');
          motionButton.setAttribute('aria-pressed', String(paused));
          setText(motionButton, paused ? '开启动效' : '暂停动效');
        },
      },
    });

    const home = el('a', {
      class: 'btn btn--ghost queue__home',
      testid: 'queue-home',
      attrs: { href: '/', rel: 'home' },
      text: '返回首页',
      on: {
        click: (event) => {
          // A modified click (new tab, new window, download) belongs to the browser.
          if (event.defaultPrevented || event.button !== 0) return;
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          this.ctx.goHome();
        },
      },
    });

    this.el = el(
      'section',
      { class: 'queue', testid: 'view-queue', data: { state: 'waiting' } },
      el(
        'div',
        { class: 'queue__stage' },
        el(
          'div',
          { class: 'duelist duelist--self', testid: 'queue-self' },
          el(
            'div',
            { class: 'duelist__art' },
            el('img', {
              class: 'duelist__crest',
              attrs: { src: ASSETS.avatars[0], alt: '', width: 130, height: 130, decoding: 'async' },
            }),
          ),
          el(
            'div',
            { class: 'duelist__body' },
            el('span', { class: 'duelist__tag', text: '你' }),
            el('span', { class: 'duelist__name', testid: 'queue-self-name', text: username }),
            this.selfNote,
          ),
        ),
        el(
          'div',
          { class: 'queue__sigil', attrs: { 'aria-hidden': 'true' } },
          el('img', {
            class: 'queue__spark',
            attrs: { src: ASSETS.spark, alt: '', width: 240, height: 240, decoding: 'async' },
          }),
          el('span', { class: 'queue__ring queue__ring--pulse' }),
          el('span', { class: 'queue__ring queue__ring--sweep' }),
          el(
            'div',
            { class: 'queue__orbit' },
            el('span', { class: 'queue__ring queue__ring--inner' }),
            el('span', { class: 'queue__mote queue__mote--a' }),
            el('span', { class: 'queue__mote queue__mote--b' }),
            el('span', { class: 'queue__mote queue__mote--c' }),
          ),
          el('img', {
            class: 'queue__core',
            attrs: { src: ASSETS.sigil, alt: '', width: 80, height: 80, decoding: 'async' },
          }),
        ),
        el(
          'div',
          { class: 'duelist duelist--rival', testid: 'queue-opponent' },
          el(
            'div',
            { class: 'duelist__art' },
            el('img', {
              class: 'duelist__crest',
              attrs: { src: ASSETS.sigil, alt: '', width: 80, height: 80, decoding: 'async' },
            }),
            el('span', { class: 'duelist__veil' }),
            el('span', { class: 'duelist__unknown', attrs: { 'aria-hidden': 'true' }, text: '?' }),
          ),
          el(
            'div',
            { class: 'duelist__body' },
            el('span', { class: 'duelist__tag duelist__tag--rival', text: '对手' }),
            el('span', { class: 'duelist__name duelist__name--unknown', text: '未知' }),
            this.rivalNote,
          ),
        ),
      ),
      el(
        'div',
        { class: 'panel queue__brief', testid: 'queue-panel' },
        el(
          'div',
          { class: 'panel__head' },
          el('h1', { text: '快速匹配' }),
          el('span', { class: 'panel__eyebrow', text: '1v1 · 同难度' }),
          motionButton,
        ),
        this.stateText,
        this.error,
        el(
          'div',
          { class: 'stat-tiles queue__facts' },
          el(
            'div',
            { class: 'tile' },
            el('div', { class: 'tile__label', text: '难度' }),
            this.difficultyText,
            el('p', { class: 'queue__difficulty-hint small faint', text: DIFFICULTY_HINTS[difficulty] }),
          ),
          el(
            'div',
            { class: 'tile queue__tile--time' },
            el('div', { class: 'tile__label', text: '已等待' }),
            this.elapsed,
          ),
        ),
        el('div', { class: 'btn-row queue__actions' }, this.cancelButton, this.requeueButton, home),
        this.hint,
      ),
    );
  }

  update(): void {
    if (this.destroyed || this.settled) return;
    if (this.timerId === null) this.timerId = window.setInterval(() => this.tick(), TICK_INTERVAL_MS);
    if (this.pollTimer === null) void this.poll();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopClock();
    this.clearPoll();
    const wasSettled = this.settled;
    this.settled = true;
    this.el.remove();
    if (!wasSettled) {
      // Leaving the view must not keep a matchmaking seat; no poll may run after.
      void api.cancelMatch().catch(() => undefined);
    }
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) window.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private stopClock(): void {
    if (this.timerId !== null) window.clearInterval(this.timerId);
    this.timerId = null;
  }

  private schedulePoll(delay: number): void {
    if (this.destroyed || this.settled) return;
    this.clearPoll();
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
  }

  private tick(): void {
    if (this.destroyed || this.settled) return;
    setText(this.elapsed, formatDuration(Date.now() - this.startedAt));
  }

  /** Paint a state once: status line, both duelist notes, the hint and the actions. */
  private renderState(state: QueueState, message = STATE_MESSAGES[state]): void {
    setData(this.el, 'state', state);
    setData(this.stateText, 'state', state);
    setText(this.stateText, message);
    setText(this.selfNote, STATE_SELF_NOTES[state]);
    setText(this.rivalNote, STATE_RIVAL_NOTES[state]);
    setText(this.hint, STATE_HINTS[state]);
    this.hint.hidden = STATE_HINTS[state].length === 0;
    setText(this.cancelButton, state === 'blocked' ? '取消已有排队' : '取消等待');
    this.cancelButton.hidden = state === 'matched' || state === 'cancelled';
    this.requeueButton.hidden = state !== 'cancelled';
  }

  /** Stop the search for good: the clock freezes at the value it reached. */
  private settle(state: QueueState, message?: string): void {
    this.settled = true;
    this.clearPoll();
    this.stopClock();
    setData(this.el, 'retry', null);
    setText(this.elapsed, formatDuration(Date.now() - this.startedAt));
    this.renderState(state, message);
  }

  private requeue(): void {
    if (this.destroyed || !this.settled) return;
    this.settled = false;
    this.ticket = null;
    this.startedAt = Date.now();
    setText(this.elapsed, formatDuration(0));
    this.error.hidden = true;
    setData(this.el, 'retry', null);
    this.renderState('waiting');
    if (this.timerId === null) this.timerId = window.setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.clearPoll();
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.destroyed || this.settled) return;
    try {
      const ticket = await api.enqueue(this.difficulty);
      if (this.destroyed || this.settled) return;
      this.ticket = ticket;
      this.error.hidden = true;
      setData(this.el, 'retry', null);

      if (ticket.state === 'matched' && ticket.roomId) {
        this.settle('matched');
        this.ctx.setPendingInvite(ticket.roomId);
        this.ctx.openRoom(ticket.roomId);
        return;
      }

      this.renderState('waiting');
      this.schedulePoll(POLL_INTERVAL_MS);
    } catch (error) {
      if (this.destroyed || this.settled) return;
      if (error instanceof ApiError && error.isAuthFailure) {
        this.ctx.handleAuthFailure('登录已过期，请重新登录后再匹配。');
        return;
      }
      if (error instanceof ApiError && error.status === 409) {
        this.showError(messageOf(error, '无法排队。'));
        this.settle('blocked');
        return;
      }
      this.showError(messageOf(error, '匹配请求失败，正在重试…'));
      setData(this.el, 'retry', 'true');
      this.renderState('waiting', '匹配服务暂时没有回应，正在自动重试…');
      this.schedulePoll(POLL_INTERVAL_MS * 2);
    }
  }

  private async cancel(): Promise<void> {
    if (this.destroyed) return;
    this.cancelButton.disabled = true;
    try {
      const { cancelled } = await api.cancelMatch();
      if (this.destroyed) return;
      if (!cancelled) {
        // The server refused: a started match already holds this account's seat.
        const roomId = this.ticket?.roomId;
        this.settle(roomId ? 'matched' : 'blocked', roomId ? undefined : '已有对局开始，请返回原对局页面继续。');
        if (roomId) {
          this.ctx.openRoom(roomId);
          return;
        }
        return;
      }
      this.error.hidden = true;
      this.settle('cancelled');
      toast('已取消匹配等待。', 'info');
    } catch (error) {
      if (this.destroyed) return;
      if (error instanceof ApiError && error.isAuthFailure) {
        this.ctx.handleAuthFailure('登录已过期，请重新登录。');
        return;
      }
      this.showError(messageOf(error, '取消匹配失败，请重试。'));
    } finally {
      if (!this.destroyed) this.cancelButton.disabled = false;
    }
  }

  private showError(message: string): void {
    setText(this.errorText, message);
    this.error.hidden = false;
  }
}
