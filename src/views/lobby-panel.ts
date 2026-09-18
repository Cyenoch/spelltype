import { DIFFICULTY_LABELS } from '../format';
import type { Player, RoomSnapshot } from '../../shared/protocol';
import { SEAT_LIMIT, avatarFallbackForSlot, avatarForSlot } from '../assets';
import { append, clear, el, image, setData, setText } from '../dom';

export interface LobbyActions {
  onReady(ready: boolean): void;
  onStart(): void;
  onLeave(): void;
  onCopyInvite(): void;
  onRetryGenerate(): void;
}

interface SeatNode {
  root: HTMLElement;
  avatar: HTMLImageElement;
  name: HTMLElement;
  meta: HTMLElement;
  badges: HTMLElement;
}

const BADGE_CLASS: Record<string, string> = {
  host: 'badge badge--host',
  ready: 'badge badge--ready',
  offline: 'badge badge--offline',
};

function seatBadge(label: string, kind: 'host' | 'ready' | 'offline', testid: string): HTMLElement {
  return el('span', { class: BADGE_CLASS[kind], text: label, testid });
}

/**
 * Lobby / preparation stage: who is here, who is ready, how to invite people,
 * and what still blocks the start. Quick-match rooms show the reservation
 * expiry so an abandoned opponent is an explained situation, not a dead end.
 */
export class LobbyPanel {
  readonly el: HTMLElement;
  private readonly seats: SeatNode[] = [];
  private readonly inviteLink: HTMLInputElement;
  private readonly roomIdText: HTMLElement;
  private readonly modeText: HTMLElement;
  private readonly themeText: HTMLElement;
  private readonly difficultyText: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly readyButton: HTMLButtonElement;
  private readonly startButton: HTMLButtonElement;
  private readonly leaveButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly reservationNote: HTMLElement;
  private readonly generatingNotice: HTMLElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly seedText: HTMLElement;
  private selfId = '';

  constructor(private readonly actions: LobbyActions) {
    this.roomIdText = el('span', { class: 'mono', testid: 'lobby-room-id', text: '—' });
    this.modeText = el('span', { testid: 'room-mode', text: '—' });
    this.themeText = el('span', { testid: 'room-theme', text: '—' });
    this.difficultyText = el('span', { testid: 'room-difficulty', text: '—' });

    this.inviteLink = el('input', {
      type: 'text',
      id: 'invite-link',
      testid: 'lobby-invite-link',
      attrs: { readonly: true, 'aria-label': '邀请链接', spellcheck: 'false' },
    });
    this.copyButton = el('button', {
      class: 'btn',
      type: 'button',
      testid: 'lobby-copy-invite',
      text: '复制邀请链接',
      on: { click: () => this.actions.onCopyInvite() },
    });

    this.readyButton = el('button', {
      class: 'btn btn--primary',
      type: 'button',
      testid: 'lobby-ready',
      text: '我准备好了',
      on: { click: () => this.actions.onReady(this.readyButton.getAttribute('aria-pressed') !== 'true') },
    });
    this.startButton = el('button', {
      class: 'btn btn--gold',
      type: 'button',
      testid: 'lobby-start',
      text: '开始对局',
      on: { click: () => this.actions.onStart() },
    });
    this.leaveButton = el('button', {
      class: 'btn btn--danger',
      type: 'button',
      testid: 'lobby-leave',
      text: '离开房间',
      on: { click: () => this.actions.onLeave() },
    });

    this.hint = el('p', { class: 'small muted', testid: 'lobby-hint', text: '' });
    this.reservationNote = el('p', {
      class: 'small',
      testid: 'lobby-reservation-note',
      text: '',
      hidden: true,
    });
    this.seedText = el('p', { class: 'small faint', testid: 'lobby-seed', text: '' });

    this.retryButton = el('button', {
      class: 'btn btn--small',
      type: 'button',
      testid: 'generating-retry',
      text: '重新生成',
      on: { click: () => this.actions.onRetryGenerate() },
    });
    this.generatingNotice = el(
      'div',
      { class: 'notice', testid: 'generating-notice', data: { tone: 'info' }, hidden: true },
      el('span', { class: 'notice__icon', text: '✶' }),
      el(
        'div',
        {},
        el('strong', { text: '正在为你们准备咒文书…' }),
        el('p', {
          class: 'small',
          text: '所有人使用相同咒文，等待不计入对战时间。',
        }),
        el(
          'div',
          { class: 'btn-row' },
          this.retryButton,
          el('button', {
            class: 'btn btn--small',
            type: 'button',
            testid: 'generating-leave',
            text: '离开房间',
            on: { click: () => this.actions.onLeave() },
          }),
        ),
      ),
    );

    const seatsGrid = el('div', { class: 'seats' });
    for (let slot = 0; slot < SEAT_LIMIT; slot += 1) {
      const seat = this.createSeat(slot);
      this.seats.push(seat);
      seatsGrid.appendChild(seat.root);
    }

    this.el = el(
      'section',
      { class: 'panel', testid: 'lobby-panel', attrs: { 'aria-label': '房间大厅' } },
      el(
        'div',
        { class: 'panel__head' },
        el('h2', { text: '房间大厅' }),
        el('span', { class: 'panel__eyebrow', text: '开战前准备' }),
      ),
      el(
        'div',
        { class: 'meta-row' },
        el('span', {}, '房间 ', this.roomIdText),
        el('span', {}, '模式 ', this.modeText),
        el('span', {}, '主题 ', this.themeText),
        el('span', {}, '难度 ', this.difficultyText),
      ),
      this.seedText,
      el('hr', { class: 'rule' }),
      seatsGrid,
      this.reservationNote,
      el('hr', { class: 'rule' }),
      el(
        'div',
        { class: 'invite' },
        el('label', { class: 'sr-only', attrs: { for: 'invite-link' }, text: '邀请链接' }),
        this.inviteLink,
        this.copyButton,
      ),
      el('div', { class: 'btn-row', attrs: { style: 'margin-top:14px' } }, this.readyButton, this.startButton, this.leaveButton),
      this.hint,
      this.generatingNotice,
    );
  }

  private createSeat(slot: number): SeatNode {
    const avatar = image(
      avatarForSlot(slot),
      '',
      'seat__avatar',
      avatarFallbackForSlot(slot),
    );
    const name = el('div', { class: 'seat__name', testid: 'lobby-slot-name', text: '' });
    const meta = el('div', { class: 'seat__meta', testid: 'lobby-slot-meta', text: '' });
    const badges = el('div', { class: 'seat__badges', testid: 'lobby-slot-badges' });
    const root = el(
      'div',
      {
        class: 'seat seat--empty',
        testid: 'lobby-slot',
        data: { slot },
        attrs: { role: 'listitem' },
      },
      avatar,
      el('div', { class: 'seat__body' }, name, meta, badges),
    );
    return { root, avatar, name, meta, badges };
  }

  setSelfId(selfId: string): void {
    this.selfId = selfId;
  }

  update(snapshot: RoomSnapshot, inviteUrl: string): void {
    const capacity = snapshot.mode === 'quick' ? 2 : SEAT_LIMIT;

    setText(this.roomIdText, snapshot.id);
    setText(this.modeText, snapshot.mode === 'quick' ? '快速匹配（1v1）' : '私人房（2–4 人）');
    setText(this.themeText, snapshot.theme);
    setText(this.difficultyText, DIFFICULTY_LABELS[snapshot.difficulty] ?? snapshot.difficulty);
    if (this.inviteLink.value !== inviteUrl) this.inviteLink.value = inviteUrl;
    this.inviteLink.hidden = snapshot.mode === 'quick';
    this.copyButton.hidden = snapshot.mode === 'quick';

    const host = snapshot.players.find((player) => player.id === snapshot.hostId);
    setText(this.seedText, host ? `房主：${host.username}` : '');

    for (let slot = 0; slot < this.seats.length; slot += 1) {
      const seat = this.seats[slot];
      const player = snapshot.players.find((candidate) => candidate.slot === slot);
      const visible = slot < capacity;
      seat.root.hidden = !visible;
      if (!visible) continue;
      if (player) this.fillSeat(seat, player, snapshot);
      else this.emptySeat(seat);
    }

    const self = snapshot.players.find((player) => player.id === this.selfId);
    const isHost = snapshot.hostId === this.selfId;
    const ready = Boolean(self?.ready);
    this.readyButton.setAttribute('aria-pressed', String(ready));
    setText(this.readyButton, ready ? '取消准备' : '我准备好了');
    this.readyButton.hidden = !self;

    this.startButton.hidden = !isHost;
    this.startButton.disabled = !this.canStart(snapshot);
    this.hint.textContent = this.startHint(snapshot, isHost);

    const quickWaiting = snapshot.mode === 'quick' && snapshot.players.length < 2;
    this.reservationNote.hidden = !(quickWaiting && snapshot.reservationExpiresAt !== null);
    setText(this.leaveButton, quickWaiting ? '离开并重新匹配' : '离开房间');

    const generating = snapshot.phase === 'generating';
    this.generatingNotice.hidden = !generating;
    this.retryButton.hidden = !isHost;
  }

  private fillSeat(seat: SeatNode, player: Player, snapshot: RoomSnapshot): void {
    const isSelf = player.id === this.selfId;
    seat.root.className = `seat${isSelf ? ' seat--self' : ''}${player.connected ? '' : ' seat--offline'}`;
    setData(seat.root, 'connected', player.connected);
    setData(seat.root, 'ready', player.ready);
    setData(seat.root, 'self', isSelf);
    setData(seat.root, 'host', player.id === snapshot.hostId);
    setData(seat.root, 'user', player.id);

    const avatarUrl = avatarForSlot(player.slot);
    if (seat.avatar.getAttribute('src') !== avatarUrl) seat.avatar.setAttribute('src', avatarUrl);
    seat.avatar.alt = `${player.username} 的头像`;

    setText(seat.name, isSelf ? `${player.username}（你）` : player.username);
    setText(
      seat.meta,
      player.connected ? `席位 ${player.slot + 1} · 已连接` : `席位 ${player.slot + 1} · 连接中断`,
    );

    clear(seat.badges);
    if (player.id === snapshot.hostId) append(seat.badges, [seatBadge('房主', 'host', 'lobby-badge-host')]);
    append(seat.badges, [
      player.ready
        ? seatBadge('已准备', 'ready', 'lobby-badge-ready')
        : seatBadge('未准备', 'offline', 'lobby-badge-not-ready'),
    ]);
    if (!player.connected) {
      append(seat.badges, [seatBadge('离线', 'offline', 'lobby-badge-offline')]);
    }
  }

  private emptySeat(seat: SeatNode): void {
    seat.root.className = 'seat seat--empty';
    setData(seat.root, 'connected', '');
    setData(seat.root, 'ready', '');
    setData(seat.root, 'self', '');
    setData(seat.root, 'host', '');
    setData(seat.root, 'user', '');
    seat.avatar.alt = '';
    setText(seat.name, '空席位');
    setText(seat.meta, '把邀请链接发给朋友');
    clear(seat.badges);
  }

  /**
   * Mirrors the room's authoritative rule: at least two connected players, no
   * seated player offline (a disconnected seat is retained, so starting would
   * be rejected), and every non-host player ready.
   */
  private canStart(snapshot: RoomSnapshot): boolean {
    const connected = snapshot.players.filter((player) => player.connected);
    if (connected.length < 2) return false;
    if (snapshot.players.some((player) => !player.connected)) return false;
    return snapshot.players.every((player) => player.id === snapshot.hostId || player.ready);
  }

  private startHint(snapshot: RoomSnapshot, isHost: boolean): string {
    const offline = snapshot.players.filter((player) => !player.connected);
    if (offline.length > 0) {
      const names = offline.map((player) => player.username).join('、');
      return `等待 ${names} 重新连接。`;
    }
    const connected = snapshot.players.filter((player) => player.connected);
    if (connected.length < 2) {
      return snapshot.mode === 'quick'
        ? '等待对手进入房间。'
        : '邀请朋友加入，至少两人即可开战。';
    }
    const waitingReady = connected.filter(
      (player) => player.id !== snapshot.hostId && !player.ready,
    );
    if (waitingReady.length > 0) {
      return `还需要这些玩家准备：${waitingReady.map((player) => player.username).join('、')}。`;
    }
    if (!isHost) return '所有人已准备，等待房主开始对局。';
    return '准备就绪，开始对决吧。';
  }

  updateReservation(remainingMs: number | null): void {
    if (remainingMs === null) {
      this.reservationNote.hidden = true;
      return;
    }
    this.reservationNote.hidden = false;
    const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
    setText(
      this.reservationNote,
      seconds > 0
        ? `等待对手进入 · 还剩 ${seconds} 秒。你也可以离开后重新匹配。`
        : '对手未能及时进入，请离开后重新匹配。',
    );
  }
}
