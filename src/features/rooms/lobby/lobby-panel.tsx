import { For, Show, createMemo } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import type { Player, RoomSnapshot } from '../../../../shared/protocol';
import { DIFFICULTY_LABELS, isPresetTheme, OPPONENT_KIND_LABELS } from '../../../ui/format';
import { ASSETS, SEAT_LIMIT } from '../../../pixi/assets';
import { ui } from '../../../ui/primitives';
import { styles } from './lobby-panel.styles';
import { Seat } from './lobby-seat';

export interface LobbyActions {
  onReady(ready: boolean): void;
  onStart(): void;
  onLeave(): void;
  onCopyRoomId(): void;
}

/**
 * Whether a seat counts as present for the lobby's readiness rules. A synthetic
 * opponent is seated by the server and always available — the lobby never waits
 * on a socket, a readiness gesture or a reconnect from it.
 */
export function seatPresent(player: Player): boolean {
  return player.connected || player.kind !== 'human';
}

/**
 * Mirrors the room's authoritative rule: still in the open lobby (never while
 * the spellbook is being prepared), at least two present players, no seated
 * human player offline, and every non-host player ready. A quick room under a
 * live reservation starts itself and refuses a manual start. A maintenance
 * window blocks the start itself, not the room.
 */
function canStart(snapshot: RoomSnapshot, admissionBlocked: boolean): boolean {
  if (snapshot.phase !== 'lobby' || admissionBlocked) return false;
  if (snapshot.mode === 'quick' && snapshot.reservationExpiresAt !== null) return false;
  if (snapshot.players.filter(seatPresent).length < 2) return false;
  if (snapshot.players.some((player) => !seatPresent(player))) return false;
  return snapshot.players.every((player) => player.id === snapshot.hostId || player.ready);
}

function joinedNames(players: { username: string }[]): string {
  return players.map((player) => player.username).join('、');
}

/**
 * The one status sentence: what the room is doing and, if it is waiting, who it
 * is waiting for. A quick room never waits for a host's start — it arms itself
 * the moment both reserved seats are online — and generation hands over to the
 * opening countdown on its own.
 */
function startHint(snapshot: RoomSnapshot, isHost: boolean, admissionBlocked: boolean): string {
  if (snapshot.phase === 'generating') {
    return '咒文书准备完成后会自动进入开场倒计时，等待期间仍可调整准备状态。';
  }
  if (snapshot.mode === 'quick' && snapshot.reservationExpiresAt !== null) {
    return snapshot.players.filter(seatPresent).length >= 2
      ? '双方已到齐，即将自动开战。'
      : '对手正在进入房间，双方到齐后自动开战。';
  }
  if (admissionBlocked) {
    return '系统维护中：暂时无法开始新对局，维护结束后即可开始。';
  }
  const offline = snapshot.players.filter((player) => !seatPresent(player));
  if (offline.length > 0) return `等待 ${joinedNames(offline)} 重新连接。`;
  if (snapshot.players.filter(seatPresent).length < 2) {
    return snapshot.mode === 'quick' ? '等待对手进入房间。' : '邀请朋友加入，至少两人即可开战。';
  }
  const waitingReady = snapshot.players.filter(
    (player) => player.id !== snapshot.hostId && !player.ready,
  );
  if (waitingReady.length > 0) return `还需要这些玩家准备：${joinedNames(waitingReady)}。`;
  // A quick room here is one whose generation failed or whose match ended:
  // the host restarts it by hand, exactly like a private room.
  if (!isHost) return '所有人已准备，等待房主开始对局。';
  return snapshot.mode === 'quick' ? '准备就绪，重新开始对决吧。' : '准备就绪，开始对决吧。';
}

/**
 * Lobby / preparation stage: the duel stage the queue screen promised — large
 * portraits on opposing sides around the central sigil — plus a compact brief
 * of room facts — the room ID doubles as the invite code, one tap copies it —
 * and one focused action row. Quick-match
 * rooms say plainly that they start themselves, and the reservation expiry
 * keeps an abandoned opponent an explained situation, not a dead end.
 */
export function LobbyPanel(props: {
  snapshot: RoomSnapshot;
  selfId: string;
  reservationRemainingMs: number | null;
  /** A maintenance window (or unknown service status) blocks starting, not the room. */
  admissionBlocked: boolean;
  /** The lobby stays mounted for the whole room; combat simply hides it. */
  hidden: boolean;
  actions: LobbyActions;
}) {
  const capacity = () => (props.snapshot.mode === 'quick' ? 2 : SEAT_LIMIT);
  const self = createMemo(() =>
    props.snapshot.players.find((player) => player.id === props.selfId),
  );
  const isHost = () => props.snapshot.hostId === props.selfId;
  const ready = createMemo(() => Boolean(self()?.ready));
  const host = createMemo(() =>
    props.snapshot.players.find((player) => player.id === props.snapshot.hostId),
  );
  const quickWaiting = () =>
    props.snapshot.mode === 'quick' &&
    props.snapshot.reservationExpiresAt !== null &&
    props.snapshot.players.filter(seatPresent).length < 2;
  const generating = createMemo(() => props.snapshot.phase === 'generating');
  /** The stage is "working" while an opponent is pending or the book cooks. */
  const stageLive = createMemo(() => generating() || quickWaiting());

  /** A quick room under a live reservation starts itself; no button exists for it. */
  const startVisible = () => {
    if (!isHost()) return false;
    if (props.snapshot.mode === 'quick') {
      return props.snapshot.phase === 'lobby' && props.snapshot.reservationExpiresAt === null;
    }
    return true;
  };

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

  /** Every seat except the viewer's own stands on the rival side. */
  const rivalSlots = () =>
    Array.from({ length: capacity() }, (_, slot) => slot).filter((slot) => slot !== self()?.slot);
  const playerAt = (slot: number) =>
    props.snapshot.players.find((candidate) => candidate.slot === slot);
  const rivalOccupied = () => rivalSlots().filter((slot) => Boolean(playerAt(slot))).length;
  /** A lone rival gets the duel portrait; extra rivals and empty slots read compact. */
  const rivalCompact = (slot: number) =>
    playerAt(slot) ? rivalOccupied() > 1 : props.snapshot.mode !== 'quick';
  const emblemCaption = createMemo(() =>
    generating() ? '咒文书准备中' : quickWaiting() ? '等待对手' : 'VS',
  );

  return (
    <section data-testid="lobby-panel" aria-label="房间大厅" hidden={props.hidden}>
      <div
        class={
          stylex.props(
            styles.stage,
            styles.stageRing,
            props.snapshot.mode === 'private' && styles.stagePrivate,
            stageLive() && styles.stageLive,
          ).className
        }
        data-testid="lobby-stage"
      >
        <div class={stylex.props(styles.side, styles.sideSelf).className}>
          <Show when={self()}>
            {(me) => (
              <Seat
                slot={me().slot}
                player={me()}
                selfId={props.selfId}
                hostId={props.snapshot.hostId}
                emptyLabel="你"
                emptyNote="正在就座…"
              />
            )}
          </Show>
        </div>

        <div class={stylex.props(styles.center).className}>
          <div class={stylex.props(styles.emblem).className} aria-hidden="true">
            <img
              class={stylex.props(styles.spark, stageLive() && styles.sparkRun).className}
              src={ASSETS.spark}
              alt=""
              width="240"
              height="240"
              decoding="async"
            />
            <span
              class={
                stylex.props(styles.ring, styles.ringPulse, stageLive() && styles.ringPulseRun)
                  .className
              }
            />
            <span
              class={
                stylex.props(styles.ring, styles.ringSweep, generating() && styles.ringSweepRun)
                  .className
              }
            />
            <div class={stylex.props(styles.orbit, generating() && styles.orbitRun).className}>
              <span class={stylex.props(styles.ring, styles.ringInner).className} />
              <span class={stylex.props(styles.mote, generating() && styles.moteRun).className} />
              <span
                class={
                  stylex.props(styles.mote, styles.moteB, generating() && styles.moteRun).className
                }
              />
              <span
                class={
                  stylex.props(styles.mote, styles.moteC, generating() && styles.moteRun).className
                }
              />
            </div>
            <img
              class={stylex.props(styles.core, stageLive() && styles.coreRun).className}
              src={ASSETS.sigil}
              alt=""
              width="80"
              height="80"
              decoding="async"
            />
          </div>
          <p
            class={
              stylex.props(styles.emblemNote, emblemCaption() === 'VS' && styles.emblemNoteVS)
                .className
            }
            data-testid="lobby-emblem-note"
          >
            {emblemCaption()}
          </p>
        </div>

        <div
          class={
            stylex.props(
              styles.side,
              styles.sideRival,
              props.snapshot.mode === 'private' && styles.sideParty,
            ).className
          }
        >
          <For each={rivalSlots()}>
            {(slot) => (
              <Seat
                slot={slot}
                player={playerAt(slot)}
                selfId={props.selfId}
                hostId={props.snapshot.hostId}
                compact={rivalCompact(slot)}
                searching={!playerAt(slot) && quickWaiting()}
                emptyLabel={props.snapshot.mode === 'quick' ? '未知' : '空席位'}
                emptyNote={
                  props.snapshot.mode === 'quick' ? '等待对手进入…' : '复制房间 ID 发给朋友'
                }
              />
            )}
          </For>
        </div>
      </div>

      <div class={stylex.props(ui.panel, styles.brief).className}>
        <div class={stylex.props(ui.panelHead).className}>
          <h2 class={stylex.props(ui.title).className}>房间大厅</h2>
          <span class={stylex.props(ui.eyebrow).className}>
            {props.snapshot.mode === 'quick' ? '1v1 · 对决准备' : '开战前准备'}
          </span>
        </div>

        <p class={stylex.props(styles.state).className} data-testid="lobby-hint" aria-live="polite">
          {startHint(props.snapshot, isHost(), props.admissionBlocked)}
        </p>

        <p
          class={stylex.props(ui.smallText, ui.faint, styles.reservation).className}
          data-testid="lobby-reservation-note"
          hidden={!reservationVisible()}
        >
          {reservationText()}
        </p>

        <Show when={generating()}>
          <div
            class={stylex.props(ui.notice, styles.generating).className}
            data-testid="generating-notice"
            data-tone="info"
          >
            <span class={stylex.props(ui.noticeIcon).className} aria-hidden="true">
              ✶
            </span>
            <div>
              <strong>正在准备咒文书…</strong>
              <p class={stylex.props(ui.smallText).className}>
                {isPresetTheme(props.snapshot.theme)
                  ? '正在获取本主题的共享咒文书；生成期间，有旧书的其他对局可直接开战。'
                  : '自定义主题不使用缓存，正在为本局单独生成咒文。'}
                等待不计入对战时间。
              </p>
            </div>
          </div>
        </Show>

        <dl class={stylex.props(styles.facts).className} data-testid="lobby-facts">
          <div class={stylex.props(styles.fact).className}>
            <dt class={stylex.props(styles.factLabel).className}>模式</dt>
            <dd class={stylex.props(styles.factValue).className} data-testid="room-mode">
              {props.snapshot.mode === 'quick' ? '快速匹配（1v1）' : '私人房（2–4 人）'}
            </dd>
          </div>
          <div class={stylex.props(styles.fact).className}>
            <dt class={stylex.props(styles.factLabel).className}>主题</dt>
            <dd class={stylex.props(styles.factValue).className} data-testid="room-theme">
              {props.snapshot.theme}
            </dd>
          </div>
          <div class={stylex.props(styles.fact).className}>
            <dt class={stylex.props(styles.factLabel).className}>难度</dt>
            <dd class={stylex.props(styles.factValue).className} data-testid="room-difficulty">
              {DIFFICULTY_LABELS[props.snapshot.difficulty] ?? props.snapshot.difficulty}
            </dd>
          </div>
          <Show when={props.snapshot.opponentKind !== 'human'}>
            <div class={stylex.props(styles.fact).className}>
              <dt class={stylex.props(styles.factLabel).className}>对手</dt>
              <dd class={stylex.props(styles.factValue).className} data-testid="room-opponent-kind">
                {`${OPPONENT_KIND_LABELS[props.snapshot.opponentKind]} · 系统安排的训练对手`}
              </dd>
            </div>
          </Show>
          <div class={stylex.props(styles.fact).className}>
            <dt class={stylex.props(styles.factLabel).className}>房主</dt>
            <dd class={stylex.props(styles.factValue).className} data-testid="lobby-seed">
              {host()?.username ?? '—'}
            </dd>
          </div>
          <div class={stylex.props(styles.fact).className}>
            <dt class={stylex.props(styles.factLabel).className}>房间 ID（邀请码）</dt>
            <dd class={stylex.props(styles.roomIdCell).className}>
              <span
                class={stylex.props(styles.factValue, styles.roomId).className}
                data-testid="lobby-room-id"
              >
                {props.snapshot.id}
              </span>
              <button
                type="button"
                class={stylex.props(ui.button, ui.small, styles.copyCode).className}
                data-testid="lobby-copy-room-id"
                onClick={() => props.actions.onCopyRoomId()}
              >
                点击复制
              </button>
            </dd>
          </div>
        </dl>

        <hr class={stylex.props(ui.rule).className} />

        <div class={stylex.props(ui.buttonRow, styles.actions).className}>
          <button
            type="button"
            class={stylex.props(ui.button, ready() ? null : ui.primary).className}
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
            hidden={!startVisible()}
            disabled={!canStart(props.snapshot, props.admissionBlocked)}
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
      </div>
    </section>
  );
}
