import { For, Show, createMemo, createSignal } from 'solid-js';
import type { Player, RoomSnapshot } from '../../../../shared/protocol';
import { arenaFor } from '../../../pixi/assets';
import { ui } from '../../../ui/primitives';
import * as stylex from '@stylexjs/stylex';
import { styles } from './battle.styles';
import { SeatCard } from './battle-seat';
import { TimerBox } from './battle-timer';
import {
  arenaIndex,
  CRITICAL_HP_RATIO,
  LOW_HP_RATIO,
  type CanvasState,
  type RenderMode,
} from './battle-view';

/**
 * The arena: canvas characters plus DOM text. The canvas is decorative and
 * optional — the DOM owns every number and keeps working when it fails.
 */
export function BattleArena(props: {
  snapshot: RoomSnapshot;
  players: Player[];
  selfId: string;
  selfCast: { progress: number; length: number };
  myTarget: number | null;
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
  const seatIds = createMemo(() => props.players.map((player) => player.id));

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
        <TimerBox phase={props.snapshot.phase} remainingMs={props.remainingMs} />
        <button
          type="button"
          class={stylex.props(ui.button, ui.small, ui.danger, ui.quiet).className}
          data-testid="battle-leave"
          onClick={() => props.onLeave()}
        >
          离开房间
        </button>
      </div>
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
              <SeatCard
                player={player()}
                isSelf={id === props.selfId}
                isTarget={props.myTarget !== null && player().slot === props.myTarget}
                aimedAtMe={props.aimingAtMe.some((candidate) => candidate.id === id)}
                render={props.render}
                selfCast={props.selfCast}
              />
            );
          }}
        </For>
      </div>
      <div
        class={
          stylex.props(
            styles.arenaCanvas,
            props.render === 'dom' && styles.arenaCanvasDom,
            props.canvasState === 'failed' && styles.arenaCanvasFailed,
          ).className
        }
        data-testid="battle-canvas-wrap"
        data-state={props.canvasState}
        ref={(el) => props.onCanvas(el)}
      />
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
