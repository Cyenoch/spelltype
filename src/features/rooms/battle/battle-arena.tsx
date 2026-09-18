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
 * The arena: canvas characters with a DOM name floating over each head. The
 * canvas is decorative and optional — the feet bars draw health, while the DOM
 * keeps the authoritative numbers for assistive tech and as the fallback display.
 */
export function BattleArena(props: {
  snapshot: RoomSnapshot;
  players: Player[];
  selfId: string;
  selfCast: { progress: number; length: number };
  /** Every seat the viewer's casts land on: all other living players. */
  myTargets: Player[];
  /** Every living opponent whose casts land on the viewer. */
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
  /* The viewer reads themselves leftmost; the canvas seating follows the same
     order, so each label stays over its character. */
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
 * The countdown shows whole seconds left, then the word `开始` at the instant the
 * deadline passes. A missing deadline (a stale snapshot) reads as `开始`, never as
 * a frozen number.
 */
function countdownSeconds(remainingMs: number | null): string {
  if (remainingMs === null) return '开始';
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  return seconds > 0 ? String(seconds) : '开始';
}
