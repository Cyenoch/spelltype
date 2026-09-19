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
 * 权威快照决定显示大厅、战斗还是专门的结算界面。
 * 大厅与战斗始终保持挂载，使打字逻辑与渲染器宿主能跨阶段存活；
 * 结算会替换它们的可见界面，而不销毁重赛所需的资源。
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
   * 画布按房间创建一次，且仅在某个战斗阶段确实需要时才创建。
   * 渲染器失败会被上报，DOM 版本的产品功能继续可用。
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
   * 字形粒子层纯粹是装饰性的，与竞技场相互独立：
   * 它按房间创建一次，失败时会被关闭，而不影响画布、咒文文本或输入框。
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

  // 两个渲染器在战斗首次需要时惰性创建一次。
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
            {/* 两个界面在整个房间生命周期内保持挂载，并通过 `hidden` 切换：
                一次重赛（finished → lobby → countdown）必须保持相同的画布宿主、
                相同的渲染器与相同的输入框。 */}
            <LobbyPanel
              hidden={inCombat() || finished() || generating()}
              snapshot={room()}
              selfId={selfId()}
              reservationRemainingMs={session.reservationRemainingMs()}
              admissionBlocked={props.ctx.maintenance.admissionBlocked()}
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
                  admissionBlocked={props.ctx.maintenance.admissionBlocked()}
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
