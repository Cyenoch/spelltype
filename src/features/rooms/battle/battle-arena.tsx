import { For, Show, createMemo, createSignal } from 'solid-js';
import type { Player, RoomSnapshot } from '../../../../shared/protocol';
import { arenaFor } from '../../../pixi/assets';
import { ui } from '../../../ui/primitives';
import * as stylex from '@stylexjs/stylex';
import { styles } from './battle.styles';
import { SeatLabel } from './battle-seat';
import { TimerBox } from './battle-timer';
import {
  arenaIndex,
  visualSeatOrder,
  CRITICAL_HP_RATIO,
  LOW_HP_RATIO,
  type CanvasState,
  type RenderMode,
} from './battle-view';
import { BattleMusic } from './battle-music';

/**
 * 竞技场：画布角色，每个头顶悬浮一个 DOM 名称。
 * 画布是装饰性且可选的 —— 脚部进度条绘制生命值，
 * 而 DOM 为无障碍技术保留权威数字，并作为兜底展示。
 */
export function BattleArena(props: {
  snapshot: RoomSnapshot;
  players: Player[];
  selfId: string;
  selfCast: { progress: number; length: number };
  /** 观察者施法会命中的所有席位：其他所有存活玩家。 */
  myTargets: Player[];
  /** 所有施法会命中观察者的存活对手。 */
  aimingAtMe: Player[];
  longTarget: boolean;
  render: RenderMode;
  canvasState: CanvasState;
  remainingMs: number | null;
  onLeave(): void;
  onCanvas(el: HTMLElement): void;
}) {
  const [backdropFailed, setBackdropFailed] = createSignal(false);
  const self = () => props.players.find((player) => player.id === props.selfId);
  const vignette = createMemo(() => {
    const me = self();
    if (!me || me.eliminatedAt !== null) return 'down';
    const ratio = me.maxHp > 0 ? me.hp / me.maxHp : 1;
    if (ratio <= CRITICAL_HP_RATIO) return 'critical';
    if (ratio <= LOW_HP_RATIO) return 'low';
    return 'none';
  });
  /* 观察者自己读作最左；画布座位遵循相同顺序，
     因此每个标签都停留在其角色上方。 */
  const seatIds = createMemo(() =>
    visualSeatOrder(props.players, props.selfId).map((player) => player.id),
  );

  return (
    <div
      class={stylex.props(styles.arena, props.longTarget ? styles.arenaLong : null).className}
      data-testid="arena"
      data-seats={props.players.length}
      data-render={props.render}
      style={`--seats:${Math.max(1, props.players.length)}`}
    >
      <img
        class={stylex.props(styles.arenaBackdrop).className}
        src={arenaFor(arenaIndex(props.snapshot.id))}
        alt=""
        decoding="async"
        aria-hidden="true"
        hidden={backdropFailed()}
        onError={() => setBackdropFailed(true)}
      />
      <div
        class={
          stylex.props(
            styles.vignette,
            vignette() === 'low' && styles.vignetteLow,
            vignette() === 'critical' && styles.vignetteCritical,
            vignette() === 'down' && styles.vignetteDown,
          ).className
        }
        aria-hidden="true"
      />
      <div class={stylex.props(styles.arenaHud).className}>
        <div class={stylex.props(styles.arenaStatus).className}>
          <span>{props.snapshot.phase === 'countdown' ? '即将开战' : '咒文对决'}</span>
          <span class={stylex.props(styles.arenaStatusDetail).className}>
            {props.players.reduce(
              (count, player) => count + Number(player.eliminatedAt === null),
              0,
            )}{' '}
            / {props.players.length} 位存活
          </span>
        </div>
        <TimerBox phase={props.snapshot.phase} remainingMs={props.remainingMs} />
        <div class={stylex.props(styles.arenaActions).className}>
          <BattleMusic active={props.snapshot.phase === 'playing'} />
          <button
            type="button"
            class={stylex.props(ui.button, ui.small, ui.quiet, styles.arenaLeave).className}
            data-testid="battle-leave"
            onClick={() => props.onLeave()}
          >
            离开房间
          </button>
        </div>
      </div>
      <div class={stylex.props(styles.arenaField).className} data-testid="arena-field">
        <div
          class={
            stylex.props(
              styles.arenaCanvas,
              props.canvasState === 'failed' && styles.arenaCanvasFailed,
            ).className
          }
          data-testid="battle-canvas-wrap"
          data-state={props.canvasState}
          ref={(el) => props.onCanvas(el)}
        />
        <div
          class={stylex.props(styles.arenaSeats).className}
          data-testid="arena-seats"
          role="list"
          aria-label="所有玩家的生命值"
        >
          <For each={seatIds()}>
            {(id) => {
              const player = () => props.players.find((candidate) => candidate.id === id) as Player;
              return (
                <SeatLabel
                  player={player()}
                  isSelf={id === props.selfId}
                  isTarget={props.myTargets.some((candidate) => candidate.id === id)}
                  aimedAtMe={props.aimingAtMe.some((candidate) => candidate.id === id)}
                  render={props.render}
                  selfCast={props.selfCast}
                />
              );
            }}
          </For>
        </div>
      </div>
      <Show when={props.snapshot.phase === 'countdown'}>
        <div class={stylex.props(styles.countdown).className} data-testid="countdown-display">
          <div class={stylex.props(styles.countdownValue).className}>
            {countdownSeconds(props.remainingMs)}
          </div>
          <div class={stylex.props(styles.countdownHint).className}>
            {props.snapshot.theme
              ? `主题「${props.snapshot.theme}」的咒文已经出现。`
              : '咒文已经出现。'}
          </div>
        </div>
      </Show>
    </div>
  );
}

/**
 * 倒计时显示剩余整数秒，在截止时间过去的那一刻则显示「开始」二字。
 * 缺失截止时间（陈旧快照）读作「开始」，而绝不是一个冻结的数字。
 */
function countdownSeconds(remainingMs: number | null): string {
  if (remainingMs === null) return '开始';
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return seconds > 0 ? String(seconds) : '开始';
}
