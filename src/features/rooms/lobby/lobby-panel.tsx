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
 * 根据大厅的准备规则判定席位是否算作在场。非真人对手由服务端安排且始终可用——
 * 大厅绝不需要等待其 WebSocket 连接、手动准备手势或断线重连。
 */
export function seatPresent(player: Player): boolean {
  return player.connected || player.kind !== 'human';
}

/**
 * 严格对齐房间权威规则：仍处于开放大厅阶段（绝不能在准备咒文书期间开战）、
 * 至少两位在场玩家、无任何已入座的人类玩家处于离线状态，且所有非房主玩家均已准备。
 * 处于有效预留期的快速匹配房间会自动开战，拒绝手动点击开战。
 * 维护窗口仅阻断开始对局本身，不影响房间存在。
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
 * 统一的状态提示语：房间当前在做什么，以及如果处于等待状态，正在等待谁。
 * 快速匹配房间绝不等待房主手动开始——双方预留席位均在线时自动启动——
 * 且咒文书生成完成后会自动交接进入开场倒计时。
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
  // 此处的快速房间指生成失败或对局刚结束的房间：
  // 由房主手动重新开局，与自定义私密房间规则相同。
  if (!isHost) return '所有人已准备，等待房主开始对局。';
  return snapshot.mode === 'quick' ? '准备就绪，重新开始对决吧。' : '准备就绪，开始对决吧。';
}

/**
 * 大厅/准备阶段面板：匹配界面所承诺的决斗舞台——
 * 左右两侧环绕中央印记的大型头像，加上紧凑的房间属性简报——
 * 房间 ID 兼作邀请码，点击一次即可复制——以及聚焦的操作按钮行。
 * 快速匹配房间会明确提示其自动开始特性，且预留到期倒计时能让被弃置的对手状态得到合理解释，避免出现死局。
 */
export function LobbyPanel(props: {
  snapshot: RoomSnapshot;
  selfId: string;
  reservationRemainingMs: number | null;
  /** 维护窗口（或未知服务状态）仅阻断开始开战，不影响大厅交互。 */
  admissionBlocked: boolean;
  /** 大厅在整个房间生命周期内保持挂载；进入战斗时仅将其隐藏。 */
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
  /** 在等待对手入房或正在烘焙咒文书时，舞台处于“工作中”的活跃状态。 */
  const stageLive = createMemo(() => generating() || quickWaiting());

  /** 处于有效预留期的快速匹配房间会自动开局；不需要也不展示开始按钮。 */
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

  /** 除用户自身席位外，所有其他席位均位于对手侧。 */
  const rivalSlots = () =>
    Array.from({ length: capacity() }, (_, slot) => slot).filter((slot) => slot !== self()?.slot);
  const playerAt = (slot: number) =>
    props.snapshot.players.find((candidate) => candidate.slot === slot);
  const rivalOccupied = () => rivalSlots().filter((slot) => Boolean(playerAt(slot))).length;
  /** 单个对手展示大型决斗头像；多个对手及空闲席位以紧凑行卡片形式展示。 */
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
