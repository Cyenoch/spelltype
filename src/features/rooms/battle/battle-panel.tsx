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
import { BattleResults } from './battle-results';
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
import { ThreatBanner } from './threat-banner';

export interface BattlePanelProps {
  snapshot: RoomSnapshot;
  selfId: string;
  /**
   * A rematch returns the room to the lobby, so the combat surface is hidden
   * rather than unmounted: its canvas hosts, the field and the renderers outlive
   * every phase change.
   */
  hidden: boolean;
  /** Bumped only by a real reconnect; the next snapshot then reconciles once. */
  reconnectedMarker: number;
  /** The one line the combat panel shows while something is wrong, or null. */
  notice: string | null;
  clock: ServerClock;
  /** Room-level repaint tick: drives the one global clock while a tab is visible. */
  tick: number;
  stage: BattleStage | null;
  typingFx: TypingEffects | null;
  canvasState: CanvasState;
  fxState: CanvasState;
  renderMode: RenderMode;
  onHosts(hosts: BattleHosts): void;
  onCommit(commit: TypingCommit): boolean;
  onPasteBlocked(): void;
  onRematch(): void;
  onLeave(): void;
}

/**
 * The combat surface: one arena with every player's health, one global clock,
 * one typing station with the recipient's current spell, and the settled
 * results. Every number shown here comes from the authoritative snapshot; the
 * canvas only draws it.
 *
 * Both surfaces are mounted as soon as the room has a snapshot and only hidden
 * while the other one is on screen: a rematch therefore keeps the same canvas
 * hosts, the same renderers and the same typing field across every phase change.
 */
export function BattlePanel(props: BattlePanelProps) {
  const typing = createBattleTyping(props);

  const view = createMemo(() => combatView(props.snapshot, props.selfId));

  /** The viewer's own card follows local typing; everyone else follows the snapshot. */
  const selfProgress = createMemo(() => {
    const self = view().self;
    const chars = typing.targetChars().length;
    if (typing.phase() === 'playing' && self && self.eliminatedAt === null && chars > 0) {
      return { progress: typing.local().progress, length: typing.local().targetLength || chars };
    }
    return { progress: self?.progress ?? 0, length: self?.spellLength ?? 0 };
  });

  /** What the field is doing, as one attribute the tests and the styling both read. */
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
      <ThreatBanner
        snapshot={props.snapshot}
        self={view().self}
        players={view().players}
        myTarget={view().myTarget}
        aimingAtMe={view().aimingAtMe}
      />

      <BattleArena
        snapshot={props.snapshot}
        players={view().players}
        selfId={props.selfId}
        selfCast={selfProgress()}
        myTarget={view().myTarget}
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

      <BattleResults
        snapshot={props.snapshot}
        self={view().self}
        players={props.snapshot.players}
        panelRef={(el) => typing.attachResultsPanel(el)}
        onRematch={() => props.onRematch()}
        onLeave={() => props.onLeave()}
      />
    </section>
  );
}
