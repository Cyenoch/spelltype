import { For, Show, createMemo } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import type { RoomSnapshot } from '../../../../shared/protocol';
import { DIFFICULTY_LABELS } from '../../../ui/format';
import { SEAT_LIMIT } from '../../../pixi/assets';
import { ui } from '../../../ui/primitives';
import { styles } from './lobby-panel.styles';
import { Seat } from './lobby-seat';

export interface LobbyActions {
  onReady(ready: boolean): void;
  onStart(): void;
  onLeave(): void;
  onCopyInvite(): void;
  onRetryGenerate(): void;
}

/**
 * Mirrors the room's authoritative rule: at least two connected players, no
 * seated player offline (a disconnected seat is retained, so starting would be
 * rejected), and every non-host player ready.
 */
function canStart(snapshot: RoomSnapshot): boolean {
  const connected = snapshot.players.filter((player) => player.connected);
  if (connected.length < 2) return false;
  if (snapshot.players.some((player) => !player.connected)) return false;
  return snapshot.players.every((player) => player.id === snapshot.hostId || player.ready);
}

/** What still blocks the start, phrased as the person the room is waiting for. */
function startHint(snapshot: RoomSnapshot, isHost: boolean): string {
  const offline = snapshot.players.filter((player) => !player.connected);
  if (offline.length > 0) {
    return `等待 ${offline.map((player) => player.username).join('、')} 重新连接。`;
  }
  const connected = snapshot.players.filter((player) => player.connected);
  if (connected.length < 2) {
    return snapshot.mode === 'quick' ? '等待对手进入房间。' : '邀请朋友加入，至少两人即可开战。';
  }
  const waitingReady = connected.filter((player) => player.id !== snapshot.hostId && !player.ready);
  if (waitingReady.length > 0) {
    return `还需要这些玩家准备：${waitingReady.map((player) => player.username).join('、')}。`;
  }
  if (!isHost) return '所有人已准备，等待房主开始对局。';
  return '准备就绪，开始对决吧。';
}

/**
 * Lobby / preparation stage: who is here, who is ready, how to invite people,
 * and what still blocks the start. Quick-match rooms show the reservation
 * expiry so an abandoned opponent is an explained situation, not a dead end.
 */
export function LobbyPanel(props: {
  snapshot: RoomSnapshot;
  selfId: string;
  inviteUrl: string;
  reservationRemainingMs: number | null;
  /** The lobby stays mounted for the whole room; combat simply hides it. */
  hidden: boolean;
  actions: LobbyActions;
}) {
  const capacity = () => (props.snapshot.mode === 'quick' ? 2 : SEAT_LIMIT);
  const self = createMemo(() =>
    props.snapshot.players.find((player) => player.id === props.selfId),
  );
  const isHost = () => props.snapshot.hostId === props.selfId;
  const ready = () => Boolean(self()?.ready);
  const host = createMemo(() =>
    props.snapshot.players.find((player) => player.id === props.snapshot.hostId),
  );
  const quickWaiting = () => props.snapshot.mode === 'quick' && props.snapshot.players.length < 2;
  const reservationVisible = () =>
    quickWaiting() &&
    props.snapshot.reservationExpiresAt !== null &&
    props.reservationRemainingMs !== null;
  const reservationText = () => {
    const remaining = props.reservationRemainingMs ?? 0;
    const seconds = Math.max(0, Math.ceil(remaining / 1000));
    return seconds > 0
      ? `等待对手进入 · 还剩 ${seconds} 秒。你也可以离开后重新匹配。`
      : '对手未能及时进入，请离开后重新匹配。';
  };

  return (
    <section
      class={stylex.props(ui.panel).className}
      data-testid="lobby-panel"
      aria-label="房间大厅"
      hidden={props.hidden}
    >
      <div class={stylex.props(ui.panelHead).className}>
        <h2 class={stylex.props(ui.title).className}>房间大厅</h2>
        <span class={stylex.props(ui.eyebrow).className}>开战前准备</span>
      </div>

      <div class={stylex.props(styles.metaRow).className}>
        <span>
          房间{' '}
          <span
            class={stylex.props(ui.mono, styles.metaValue).className}
            data-testid="lobby-room-id"
          >
            {props.snapshot.id}
          </span>
        </span>
        <span>
          模式{' '}
          <span class={stylex.props(styles.metaValue).className} data-testid="room-mode">
            {props.snapshot.mode === 'quick' ? '快速匹配（1v1）' : '私人房（2–4 人）'}
          </span>
        </span>
        <span>
          主题{' '}
          <span class={stylex.props(styles.metaValue).className} data-testid="room-theme">
            {props.snapshot.theme}
          </span>
        </span>
        <span>
          难度{' '}
          <span class={stylex.props(styles.metaValue).className} data-testid="room-difficulty">
            {DIFFICULTY_LABELS[props.snapshot.difficulty] ?? props.snapshot.difficulty}
          </span>
        </span>
      </div>

      <p class={stylex.props(ui.smallText, ui.faint).className} data-testid="lobby-seed">
        {host() ? `房主：${host()!.username}` : ''}
      </p>

      <hr class={stylex.props(ui.rule).className} />

      <div class={stylex.props(styles.seats).className}>
        <For each={Array.from({ length: SEAT_LIMIT }, (_, index) => index)}>
          {(slot) => (
            <Seat
              slot={slot}
              hidden={slot >= capacity()}
              player={props.snapshot.players.find((candidate) => candidate.slot === slot)}
              selfId={props.selfId}
              hostId={props.snapshot.hostId}
            />
          )}
        </For>
      </div>

      <p
        class={stylex.props(ui.smallText).className}
        data-testid="lobby-reservation-note"
        hidden={!reservationVisible()}
      >
        {reservationText()}
      </p>

      <hr class={stylex.props(ui.rule).className} />

      <div class={stylex.props(styles.invite).className} hidden={props.snapshot.mode === 'quick'}>
        <label class={stylex.props(ui.srOnly).className} for="invite-link">
          邀请链接
        </label>
        <input
          type="text"
          id="invite-link"
          data-testid="lobby-invite-link"
          class={stylex.props(ui.input, styles.inviteInput).className}
          readonly
          aria-label="邀请链接"
          spellcheck={false}
          value={props.inviteUrl}
        />
        <button
          type="button"
          class={stylex.props(ui.button).className}
          data-testid="lobby-copy-invite"
          onClick={() => props.actions.onCopyInvite()}
        >
          复制邀请链接
        </button>
      </div>

      <div class={stylex.props(ui.buttonRow, styles.actions).className}>
        <button
          type="button"
          class={stylex.props(ui.button, ui.primary).className}
          data-testid="lobby-ready"
          aria-pressed={ready()}
          hidden={!self()}
          onClick={() => props.actions.onReady(!ready())}
        >
          {ready() ? '取消准备' : '我准备好了'}
        </button>
        <button
          type="button"
          class={stylex.props(ui.button, ui.gold).className}
          data-testid="lobby-start"
          hidden={!isHost()}
          disabled={!canStart(props.snapshot)}
          onClick={() => props.actions.onStart()}
        >
          开始对局
        </button>
        <button
          type="button"
          class={stylex.props(ui.button, ui.danger).className}
          data-testid="lobby-leave"
          onClick={() => props.actions.onLeave()}
        >
          {quickWaiting() ? '离开并重新匹配' : '离开房间'}
        </button>
      </div>

      <p class={stylex.props(ui.smallText, ui.muted).className} data-testid="lobby-hint">
        {startHint(props.snapshot, isHost())}
      </p>

      <Show when={props.snapshot.phase === 'generating'}>
        <div
          class={stylex.props(ui.notice).className}
          data-testid="generating-notice"
          data-tone="info"
        >
          <span class={stylex.props(ui.noticeIcon).className}>✶</span>
          <div>
            <strong>正在为你们准备咒文书…</strong>
            <p class={stylex.props(ui.smallText).className}>
              所有人使用相同咒文，等待不计入对战时间。
            </p>
            <div class={stylex.props(ui.buttonRow).className}>
              <button
                type="button"
                class={stylex.props(ui.button, ui.small).className}
                data-testid="generating-retry"
                hidden={!isHost()}
                onClick={() => props.actions.onRetryGenerate()}
              >
                重新生成
              </button>
              <button
                type="button"
                class={stylex.props(ui.button, ui.small).className}
                data-testid="generating-leave"
                onClick={() => props.actions.onLeave()}
              >
                离开房间
              </button>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
