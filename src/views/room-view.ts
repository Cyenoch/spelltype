import type { ClientMessage, RoomSnapshot } from '../../shared/protocol';
import { api, ApiError } from '../api';
import type { AppContext, View } from '../context';
import { append, clear, el, setData, setText } from '../dom';
import { LobbyPanel } from './lobby-panel';
import { BattlePanel } from './battle-panel';
import { RoomConnection, type CloseInfo, type ConnectionState } from '../room-connection';
import { createBattleStage, type BattleStage } from '../pixi/stage';
import { createTypingEffects } from '../pixi/typing-effects';
import { PHASE_LABELS } from '../format';
import { toast } from '../toast';
import type { TypingCommit } from '../typing';

const PHASE_LABELS_FALLBACK = '房间';

/**
 * One room: authoritative snapshots in, lobby/combat surfaces out. The panel
 * set and the spell field are mounted once per room, so a phase change never
 * destroys the field a player is typing into.
 */
export class RoomView implements View {
  readonly el: HTMLElement;
  private readonly header: HTMLElement;
  private readonly statusPhase: HTMLElement;
  private readonly roomIdText: HTMLElement;
  private readonly errorNotice: HTMLElement;
  private readonly errorText: HTMLElement;
  private readonly errorActions: HTMLElement;
  private readonly loading: HTMLElement;
  private readonly lobby: LobbyPanel;
  private readonly battle: BattlePanel;
  private readonly connection: RoomConnection;

  private snapshot: RoomSnapshot | null = null;
  private stagePromise: Promise<void> | null = null;
  private typingFxPromise: Promise<void> | null = null;
  private lastError: string | null = null;
  private lastServerNow = 0;
  private timerId: number | null = null;
  private closed = false;
  private persistenceWarned = false;

  constructor(
    private readonly roomId: string,
    private readonly ctx: AppContext,
  ) {
    this.loading = el(
      'div',
      { class: 'panel', testid: 'room-loading' },
      el('p', { class: 'muted', text: '正在进入房间…' }),
    );

    this.errorText = el('div', { text: '' });
    this.errorActions = el('div', { class: 'btn-row' });
    this.errorNotice = el(
      'div',
      { class: 'notice', testid: 'room-error', data: { tone: 'error' }, hidden: true },
      el('span', { class: 'notice__icon', text: '✖' }),
      this.errorText,
      this.errorActions,
    );

    this.statusPhase = el('span', { class: 'hud__phase', testid: 'room-status', text: '连接中' });
    this.roomIdText = el('span', { class: 'mono faint', testid: 'room-id-label', text: roomId });
    this.header = el(
      'div',
      { class: 'room-head' },
      el('div', { class: 'room-head__title' }, this.statusPhase, this.roomIdText),
    );

    this.lobby = new LobbyPanel({
      onReady: (ready) => this.send({ type: 'ready', ready }, '准备状态未能送达，正在重连…'),
      onStart: () => this.send({ type: 'start' }, '开始指令未能送达，正在重连…'),
      onLeave: () => this.leaveRoom(),
      onCopyInvite: () => this.copyInvite(),
      onRetryGenerate: () => this.send({ type: 'start' }, '重试指令未能送达，正在重连…'),
    });

    this.battle = new BattlePanel(ctx.clock, roomId, {
      onCommit: (commit) => this.commitInput(commit),
      onPasteBlocked: () => toast('咒文对决禁止粘贴整段文本，请自己输入。', 'warn'),
      onRematch: () => {
        this.send({ type: 'rematch' }, '再来一局指令未能送达，正在重连…');
        toast('已申请再来一局：所有人重新准备后，房主再次开始。', 'info');
      },
      onLeave: () => this.leaveRoom(),
    });

    this.el = el(
      'section',
      { testid: 'view-room', data: { 'room-id': roomId, connection: 'idle' } },
      this.errorNotice,
      this.header,
      this.loading,
      this.lobby.el,
      this.battle.el,
    );

    this.lobby.el.hidden = true;
    this.battle.el.hidden = true;

    this.connection = new RoomConnection(roomId, {
      onSnapshot: (snapshot, meta) => this.handleSnapshot(snapshot, meta.reconnected),
      onServerError: (message) => toast(message, 'error'),
      onServerNow: (serverNow) => this.ctx.clock.sync(serverNow),
      onState: (state) => this.renderConnection(state),
      onClosed: (info) => this.handleClosed(info),
      onReconnectAttempt: () => this.renderConnection('reconnecting'),
    });
  }

  async start(): Promise<void> {
    try {
      const snapshot = await api.room(this.roomId);
      this.handleSnapshot(snapshot, false, true);
    } catch (error) {
      if (error instanceof ApiError && error.isAuthFailure) {
        this.ctx.handleAuthFailure('登录已过期，请重新登录后再进入房间。');
        return;
      }
      this.showFatal(error);
      return;
    }
    this.connection.open();
    if (this.timerId === null) {
      this.timerId = window.setInterval(() => this.tick(), 100);
    }
  }

  destroy(): void {
    this.closed = true;
    if (this.timerId !== null) window.clearInterval(this.timerId);
    this.timerId = null;
    this.connection.destroy();
    this.battle.destroy();
    this.ctx.setRoomConnection('idle');
    this.el.remove();
  }

  private send(message: ClientMessage, failureHint: string): void {
    if (!this.connection.send(message)) {
      toast(failureHint, 'warn');
      this.renderConnection(this.connection.currentState);
    }
  }

  /**
   * Input is only ever forwarded for the spell index the field is bound to: a
   * commit for an older index (a late keystroke after a cast was accepted) is
   * dropped here, and the room rejects anything else as stale.
   */
  private commitInput(commit: TypingCommit): boolean {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.matchId === null) return false;
    if (commit.matchId !== snapshot.matchId) return false;
    if (snapshot.phase !== 'playing') return false;
    const self = snapshot.players.find((player) => player.id === this.selfId());
    if (!self || self.eliminatedAt !== null) return false;
    if (commit.spellIndex !== self.spellIndex) return false;
    const sent = this.connection.send({
      type: 'input',
      matchId: commit.matchId,
      spellIndex: commit.spellIndex,
      text: commit.text,
    });
    if (!sent) {
      this.battle.setNotice(
        '连接中断，本次输入尚未保存。重连后将恢复已保存的进度。',
        'warn',
      );
      return false;
    }
    return true;
  }

  private selfId(): string {
    return this.ctx.session.user?.id ?? '';
  }

  private copyInvite(): void {
    const url = this.ctx.inviteUrl(this.roomId);
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      clipboard.writeText(url).then(
        () => toast('邀请链接已复制，发给朋友即可进入这个房间。', 'good'),
        () => toast(`请手动复制邀请链接：${url}`, 'warn'),
      );
      return;
    }
    toast(`请手动复制邀请链接：${url}`, 'warn');
  }

  private leaveRoom(): void {
    const snapshot = this.snapshot;
    const quick = snapshot?.mode === 'quick';
    const delivered = this.connection.leave();
    this.ctx.setPendingInvite(null);
    this.ctx.goHome();
    if (quick && !delivered) {
      // The socket was down: release the queue/reservation over HTTP instead.
      void api.cancelMatch().catch(() => undefined);
    }
    toast(quick ? '已离开快速匹配房间，可以重新匹配。' : '已离开房间。', 'info');
  }

  private handleSnapshot(snapshot: RoomSnapshot, reconnected: boolean, initial = false): void {
    if (this.closed) return;
    // A snapshot that is older than the last one applied (a stale HTTP read
    // racing a live socket) must never move the display backwards.
    if (!initial && this.snapshot && snapshot.serverNow < this.lastServerNow) return;
    this.lastServerNow = snapshot.serverNow;

    this.snapshot = snapshot;
    this.ctx.clock.sync(snapshot.serverNow);
    if (initial) {
      this.loading.hidden = true;
      this.ctx.setPendingInvite(snapshot.id);
    }

    this.renderHeader(snapshot);
    this.renderErrors(snapshot);
    this.renderPersistenceHint(snapshot);

    this.lobby.setSelfId(this.selfId());
    this.lobby.update(snapshot, this.ctx.inviteUrl(snapshot.id));

    const inCombat = snapshot.phase === 'countdown' || snapshot.phase === 'playing' || snapshot.phase === 'finished';
    this.lobby.el.hidden = inCombat;
    this.battle.el.hidden = !inCombat;

    if (inCombat) {
      this.battle.sync(snapshot, this.selfId(), { reconnected });
      void this.ensureStage();
      void this.ensureTypingEffects();
    }

    if (reconnected) toast('已重新连接，进度已恢复。', 'good');
  }

  private renderHeader(snapshot: RoomSnapshot): void {
    setText(this.statusPhase, PHASE_LABELS[snapshot.phase] ?? PHASE_LABELS_FALLBACK);
    setData(this.el, 'phase', snapshot.phase);
    setData(this.el, 'mode', snapshot.mode);
    setText(this.roomIdText, snapshot.id);
  }

  private renderErrors(snapshot: RoomSnapshot): void {
    const message = snapshot.error;
    if (!message) {
      if (this.lastError) {
        this.errorNotice.hidden = true;
        this.lastError = null;
      }
      return;
    }
    if (message === this.lastError) return;
    this.lastError = message;
    this.showProblem(message, 'error', false);
  }

  private showProblem(message: string, tone: 'warn' | 'error', notify = true): void {
    setText(this.errorText, message);
    setData(this.errorNotice, 'tone', tone);
    this.errorNotice.hidden = false;
    this.renderRecoveryActions(this.snapshot);
    if (notify) toast(message, tone);
  }

  private renderRecoveryActions(snapshot: RoomSnapshot | null): void {
    clear(this.errorActions);
    if (!snapshot) {
      append(this.errorActions, [
        el('button', {
          class: 'btn btn--small',
          type: 'button',
          testid: 'room-error-home',
          text: '返回首页',
          on: { click: () => this.ctx.goHome() },
        }),
      ]);
      return;
    }
    append(this.errorActions, [
      el('button', {
        class: 'btn btn--small btn--gold',
        type: 'button',
        testid: 'room-error-retry',
        text: snapshot.mode === 'quick' ? '重新匹配' : '创建新房间',
        on: {
          click: () => {
            if (snapshot.mode === 'quick') this.ctx.goQueue(snapshot.difficulty);
            else this.ctx.goCreate();
          },
        },
      }),
      el('button', {
        class: 'btn btn--small',
        type: 'button',
        testid: 'room-error-home',
        text: '返回首页',
        on: { click: () => this.ctx.goHome() },
      }),
    ]);
  }

  private renderPersistenceHint(snapshot: RoomSnapshot): void {
    if (snapshot.phase !== 'finished') {
      this.persistenceWarned = false;
      return;
    }
    if (snapshot.persistence !== 'error' || this.persistenceWarned) return;
    this.persistenceWarned = true;
    toast('战绩暂未保存，正在自动重试。本场结果不受影响。', 'warn');
  }

  private renderConnection(state: ConnectionState): void {
    if (state === 'reconnecting') setText(this.statusPhase, '重连中…');
    else if (state === 'connecting') setText(this.statusPhase, '连接中…');
    setData(this.header, 'connection', state);
    setData(this.el, 'connection', state);
    this.ctx.setRoomConnection(state);

    if (this.battle.el.hidden) return;
    this.battle.setConnectedHint(state === 'idle' ? 'closed' : state);
  }

  private handleClosed(info: CloseInfo): void {
    if (this.closed) return;
    if (info.authExpired) {
      this.ctx.handleAuthFailure('登录状态已失效，请重新登录。');
      return;
    }
    if (info.replaced) {
      this.showProblem('这个账号的房间连接已被另一个窗口接管，本窗口不再操作该席位。', 'warn');
      return;
    }
    if (info.roomClosed) {
      this.showProblem(this.lastError ?? '房间已关闭或不再接受你加入（可能已经开始或结束）。', 'error');
      return;
    }
    if (this.snapshot?.phase === 'playing' || this.snapshot?.phase === 'countdown') {
      toast('连接中断，正在重连。对战计时不会暂停。', 'warn');
    }
  }

  private showFatal(error: unknown): void {
    this.loading.hidden = true;
    const message = error instanceof Error && error.message ? error.message : '无法进入这个房间。';
    this.lastError = message;
    this.showProblem(message, 'error');
    this.ctx.setPendingInvite(null);
  }

  /**
   * The canvas is created once per room, and only when a combat phase actually
   * needs it. A failed renderer is reported and the DOM product keeps working.
   */
  private async ensureStage(): Promise<void> {
    if (this.stagePromise) return this.stagePromise;
    const bootstrap = (async () => {
      const host = this.battle.renderHost;
      try {
        const stage: BattleStage = await createBattleStage(host);
        if (this.closed) {
          stage.destroy();
          return;
        }
        this.battle.attachStage(stage);
        const snapshot = this.snapshot;
        if (snapshot && !this.battle.el.hidden) {
          this.battle.sync(snapshot, this.selfId(), { reconnected: false });
        }
      } catch (error) {
        this.battle.markStageFailed();
        this.ctx.reportGraphicsFailure(error instanceof Error ? error.message : '未知渲染错误');
      }
    })();
    this.stagePromise = bootstrap;
    return bootstrap;
  }

  /**
   * The glyph particle layer is purely decorative and independent of the arena:
   * it is created once per room, and a failure switches it off without touching
   * the canvas, the spell text or the input.
   */
  private async ensureTypingEffects(): Promise<void> {
    if (this.typingFxPromise) return this.typingFxPromise;
    const bootstrap = (async () => {
      try {
        const effects = await createTypingEffects(this.battle.fxRenderHost);
        if (this.closed) {
          effects.destroy();
          return;
        }
        this.battle.attachTypingEffects(effects);
      } catch {
        this.battle.markTypingEffectsFailed();
      }
    })();
    this.typingFxPromise = bootstrap;
    return bootstrap;
  }

  private tick(): void {
    // The clock keeps running while a tab is hidden; only the repaint is skipped.
    if (this.closed || document.visibilityState === 'hidden') return;
    const snapshot = this.snapshot;
    if (!snapshot) return;
    this.battle.updateTimer();
    if (snapshot.phase === 'lobby' && snapshot.reservationExpiresAt !== null) {
      this.lobby.updateReservation(snapshot.reservationExpiresAt - this.ctx.clock.now());
    } else if (snapshot.phase === 'lobby') {
      this.lobby.updateReservation(null);
    }
  }
}
