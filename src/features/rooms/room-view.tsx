import { Show, createEffect, createMemo, createSignal, onCleanup } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import type { AppContext } from '../../app/context';
import { PHASE_LABELS } from '../../ui/format';
import { createBattleStage, type BattleStage } from '../../pixi/stage/battle-stage';
import { createTypingEffects, type TypingEffects } from '../../pixi/typing-effects';
import { toast } from '../../ui/toast';
import type { CanvasState, RenderMode } from './battle/battle-view';
import { BattlePanel } from './battle/battle-panel';
import { BattleResults } from './battle/battle-results';
import { BattleGeneration } from './battle/battle-generation';
import { LobbyPanel, type LobbyActions } from './lobby/lobby-panel';
import { RoomNotice } from './room-notice';
import { createRoomSession, type RoomLoad } from './room-session';
import { styles } from './room-view.styles';

const CONNECTION_LABELS: Record<'connecting' | 'reconnecting', string> = {
  connecting: '连接中…',
  reconnecting: '重连中…',
};

/**
 * Authoritative snapshots select the lobby, combat or dedicated results screen.
 * Lobby and combat stay mounted so typing and renderer hosts survive phase changes;
 * settlement replaces their visible surface without destroying rematch resources.
 */
export function RoomView(props: { roomId: string; ctx: AppContext; initial: RoomLoad }) {
  const session = createRoomSession(props);

  const [canvasState, setCanvasState] = createSignal<CanvasState>('pending');
  const [fxState, setFxState] = createSignal<CanvasState>('pending');
  const [stage, setStage] = createSignal<BattleStage | null>(null);
  const [typingFx, setTypingFx] = createSignal<TypingEffects | null>(null);

  let closed = false;
  let stagePromise: Promise<void> | null = null;
  let fxPromise: Promise<void> | null = null;
  let hosts: { canvas: HTMLElement; fx: HTMLElement } | null = null;

  const phase = () => session.snapshot()?.phase ?? 'lobby';
  const finished = createMemo(() => phase() === 'finished');
  const generating = createMemo(() => phase() === 'generating');
  const inCombat = () => phase() === 'countdown' || phase() === 'playing';
  const renderMode = (): RenderMode => (canvasState() === 'ready' ? 'canvas' : 'dom');
  const selfId = () => props.ctx.session.user?.id ?? '';

  const statusText = createMemo(() => {
    const state = session.connection();
    if (state === 'connecting' || state === 'reconnecting') return CONNECTION_LABELS[state];
    const current = session.snapshot();
    return current ? (PHASE_LABELS[current.phase] ?? '房间') : CONNECTION_LABELS.connecting;
  });

  const statusDimmed = createMemo(
    () => session.connection() === 'connecting' || session.connection() === 'reconnecting',
  );

  const lobbyActions: LobbyActions = {
    onReady: (ready) => session.send({ type: 'ready', ready }, '准备状态未能送达，正在重连…'),
    onStart: () => session.send({ type: 'start' }, '开始指令未能送达，正在重连…'),
    onLeave: () => void session.leaveRoom(),
    onCopyRoomId: () => session.copyRoomId(),
  };

  /**
   * The canvas is created once per room, and only when a combat phase actually
   * needs it. A failed renderer is reported and the DOM product keeps working.
   */
  function ensureStage(): void {
    if (stagePromise || !hosts) return;
    const host = hosts.canvas;
    stagePromise = (async () => {
      try {
        const created = await createBattleStage(host);
        if (closed) {
          created.destroy();
          return;
        }
        setStage(created);
        setCanvasState('ready');
      } catch (error) {
        setCanvasState('failed');
        props.ctx.reportGraphicsFailure(error instanceof Error ? error.message : '未知渲染错误');
      }
    })();
  }

  /**
   * The glyph particle layer is purely decorative and independent of the arena:
   * it is created once per room, and a failure switches it off without touching
   * the canvas, the spell text or the input.
   */
  function ensureTypingEffects(): void {
    if (fxPromise || !hosts) return;
    const host = hosts.fx;
    fxPromise = (async () => {
      try {
        const created = await createTypingEffects(host);
        if (closed) {
          created.destroy();
          return;
        }
        setTypingFx(created);
        setFxState('ready');
      } catch {
        setFxState('failed');
      }
    })();
  }

  onCleanup(() => {
    closed = true;
    stage()?.destroy();
    typingFx()?.destroy();
  });

  // The two renderers are created lazily, once, when combat first needs them.
  createEffect(() => {
    if (inCombat() && hosts) {
      ensureStage();
      ensureTypingEffects();
    }
  });

  return (
    <section
      data-testid="view-room"
      data-room-id={props.roomId}
      data-connection={session.connection()}
      data-phase={session.snapshot()?.phase ?? ''}
      data-mode={session.snapshot()?.mode ?? ''}
    >
      <Show when={session.problem()}>
        {(current) => (
          <RoomNotice
            problem={current()}
            snapshot={session.snapshot()}
            leaveRoom={(destination) => session.leaveRoom(destination)}
            leavePending={session.leavePending()}
          />
        )}
      </Show>

      <div
        class={stylex.props(styles.roomHead).className}
        data-connection={session.connection()}
        hidden={!session.snapshot() || finished() || generating()}
      >
        <span
          class={stylex.props(styles.phase, statusDimmed() && styles.phaseDim).className}
          data-testid="room-status"
        >
          {statusText()}
        </span>
      </div>

      <Show when={session.snapshot()}>
        {(room) => (
          <>
            {/* Both surfaces stay mounted for the whole room and are toggled with
                `hidden`: a rematch (finished → lobby → countdown) must keep the same
                canvas hosts, the same renderers and the same typing field. */}
            <LobbyPanel
              hidden={inCombat() || finished() || generating()}
              snapshot={room()}
              selfId={selfId()}
              reservationRemainingMs={session.reservationRemainingMs()}
              actions={lobbyActions}
            />
            <BattlePanel
              hidden={!inCombat()}
              snapshot={room()}
              selfId={selfId()}
              reconnectedMarker={session.reconnectedMarker()}
              notice={session.battleNotice()}
              clock={props.ctx.clock}
              tick={session.tick()}
              stage={stage()}
              typingFx={typingFx()}
              canvasState={canvasState()}
              fxState={fxState()}
              renderMode={renderMode()}
              onHosts={(next) => {
                hosts = next;
                if (inCombat()) {
                  ensureStage();
                  ensureTypingEffects();
                }
              }}
              onCommit={(commit) => session.commitInput(commit)}
              onPasteBlocked={() => toast('咒文对决禁止粘贴整段文本，请自己输入。', 'warn')}
              onLeave={() => void session.leaveRoom()}
            />
            <Show when={generating()}>
              <div data-testid="view-generation">
                <BattleGeneration
                  snapshot={room()}
                  notice={session.battleNotice()}
                  onLeave={() => void session.leaveRoom()}
                />
              </div>
            </Show>
            <Show when={finished()}>
              <div data-testid="view-results">
                <BattleResults
                  snapshot={room()}
                  self={room().players.find((player) => player.id === selfId())}
                  players={room().players}
                  onRematch={() => {
                    session.send({ type: 'rematch' }, '再来一局指令未能送达，正在重连…');
                    toast('已申请再来一局：所有人重新准备后，房主再次开始。', 'info');
                  }}
                  onLeave={() => void session.leaveRoom()}
                />
              </div>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
