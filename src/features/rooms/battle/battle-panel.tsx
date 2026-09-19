import { Show, createEffect, createMemo } from 'solid-js';
import type { RoomSnapshot } from '../../../../shared/protocol';
import type { ServerClock } from '../../../app/clock';
import type { BattleStage } from '../../../pixi/stage/battle-stage';
import type { TypingEffects } from '../../../pixi/typing-effects';
import type { TypingCommit } from './typing';
import { ui } from '../../../ui/primitives';
import * as stylex from '@stylexjs/stylex';
import { styles } from './battle.styles';
import { BattleArena } from './battle-arena';
import { BattleStation } from './battle-station';
import { createBattleTyping, type BattleHosts } from './battle-typing';
import {
  combatView,
  CRITICAL_HP_RATIO,
  LOW_HP_RATIO,
  type CanvasState,
  type RenderMode,
} from './battle-view';
import { CombatLog } from './combat-log';

export interface BattlePanelProps {
  snapshot: RoomSnapshot;
  selfId: string;
  /**
   * 一次重赛会让房间回到大厅，因此战斗界面是被隐藏而非卸载：
   * 其画布宿主、输入框与渲染器都能跨过每一次阶段变化而存续。
   */
  hidden: boolean;
  /** 仅由真正的重连递增；随后到达的那份快照会对账一次。 */
  reconnectedMarker: number;
  /** 出问题时战斗面板展示的那一行提示，或 null。 */
  notice: string | null;
  clock: ServerClock;
  /** 房间级重绘心跳：在标签页可见时驱动那个唯一的全局时钟。 */
  tick: number;
  stage: BattleStage | null;
  typingFx: TypingEffects | null;
  canvasState: CanvasState;
  fxState: CanvasState;
  renderMode: RenderMode;
  onHosts(hosts: BattleHosts): void;
  onCommit(commit: TypingCommit): boolean;
  onPasteBlocked(): void;
  onLeave(): void;
}

/**
 * 战斗界面：一座展示所有玩家生命值的竞技场、一个全局时钟、
 * 一个包含接收者当前咒文的打字站，以及战斗日志。
 * 此处展示的每个数字都来自权威快照；画布只是把它画出来。
 *
 * 房间一旦有快照便挂载两个界面，仅在另一个界面显示时将其隐藏：
 * 因此一次重赛能在每一次阶段变化中保持相同的画布宿主、相同的渲染器与相同的输入框。
 */
export function BattlePanel(props: BattlePanelProps) {
  const typing = createBattleTyping(props);

  const view = createMemo(() => combatView(props.snapshot, props.selfId));

  /** 观察者自己的卡片跟随本地打字；其他所有人跟随快照。 */
  const selfProgress = createMemo(() => {
    const self = view().self;
    const chars = typing.targetChars().length;
    if (typing.phase() === 'playing' && self && self.eliminatedAt === null && chars > 0) {
      return { progress: typing.local().progress, length: typing.local().targetLength || chars };
    }
    return { progress: self?.progress ?? 0, length: self?.spellLength ?? 0 };
  });

  /** 输入框当前的状态，作为一个测试与样式共同读取的属性。 */
  const inputState = createMemo(() => {
    if (typing.finished()) return 'locked';
    if (typing.phase() !== 'playing') return 'idle';
    if (typing.eliminated()) return 'eliminated';
    if (typing.local().pending) return 'pending';
    if (typing.castState() === 'done') return 'complete';
    return typing.local().progress > 0 ? 'typing' : 'idle';
  });

  const hpState = createMemo(() => {
    const self = view().self;
    if (!self || self.eliminatedAt !== null) return 'down';
    const ratio = self.maxHp > 0 ? self.hp / self.maxHp : 1;
    if (ratio <= CRITICAL_HP_RATIO) return 'critical';
    if (ratio <= LOW_HP_RATIO) return 'low';
    return 'ok';
  });

  createEffect(() => {
    const stage = props.stage;
    stage?.update(props.snapshot, props.selfId);
  });

  return (
    <section
      class={stylex.props(styles.combat).className}
      data-testid="battle-panel"
      hidden={props.hidden}
      data-phase={typing.phase()}
      data-match-id={props.snapshot.matchId ?? ''}
      data-spell-index={view().self ? view().self!.spellIndex : ''}
      data-spells-cast={view().self ? view().self!.spellsCast : ''}
      data-input-state={inputState()}
      data-render={props.renderMode}
      data-deadline={props.snapshot.deadline}
      data-started-at={props.snapshot.startedAt ?? ''}
      data-end-reason={props.snapshot.endReason ?? ''}
      data-hp-state={hpState()}
      data-long-target={String(typing.glyphs.longTarget())}
      data-element={props.snapshot.spell?.element ?? ''}
      data-wrong-extra={String(
        Array.from(typing.local().text).length > typing.targetChars().length,
      )}
    >
      <BattleArena
        snapshot={props.snapshot}
        players={view().players}
        selfId={props.selfId}
        selfCast={selfProgress()}
        myTargets={view().myTargets}
        aimingAtMe={view().aimingAtMe}
        longTarget={typing.glyphs.longTarget()}
        render={props.renderMode}
        canvasState={props.canvasState}
        remainingMs={typing.remainingMs()}
        onLeave={() => props.onLeave()}
        onCanvas={(el) => typing.attachCanvasHost(el)}
      />

      <div
        class={stylex.props(styles.notices).className}
        data-testid="battle-notice"
        hidden={props.notice === null}
      >
        <Show when={props.notice}>
          {(message) => (
            <div class={stylex.props(ui.notice, styles.noticeTight).className} data-tone="warn">
              <span class={stylex.props(ui.noticeIcon).className}>⚠</span>
              <div>{message()}</div>
            </div>
          )}
        </Show>
      </div>

      <BattleStation snapshot={props.snapshot} selfPlayer={view().self} typing={typing} />

      <CombatLog events={props.snapshot.events} players={props.snapshot.players} />
    </section>
  );
}
