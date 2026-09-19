import type { Arena } from '../arena';
import type { Fighter, FighterState } from '../fighter/fighter';
import type { FxLayer } from '../effects/layer';
import type { AimLayer } from './aim';
import type { Choreography } from './choreography';
import type { GlyphLayer } from './glyphs';
import type { Seating } from './seating';
import type { StageAssets } from './assets';
import type { Combat } from './combat';
import type { Element, Player, RoomSnapshot } from '../../../shared/protocol';

const FINAL_SECONDS_MS = 10_000;
const GLYPH_MIN_GAP_MS = 70;

/** 对局投影所读取和写入的全部内容。 */
export interface MatchWiring {
  host: HTMLElement;
  fighters: readonly Fighter[];
  seating: Seating;
  arena: Arena;
  aim: AimLayer;
  assets: StageAssets;
  combat: Combat;
  glyphs: GlyphLayer;
  fx: FxLayer;
  choreography: Choreography;
  /** 丢弃所有存活中的效果与粒子：新对局从空竞技场开始。 */
  clearEffects: () => void;
  /** 席位变化后重新布局竞技场。 */
  relayout: () => void;
  /** 渲染一帧，并将其计入按需绘制次数。 */
  paint: () => void;
  /** 帧时钟，单位毫秒，与帧循环共享。 */
  clock: () => number;
  /** 竞技场运行在减弱动效模式时为 true。 */
  reduced: () => boolean;
}

/**
 * 屏幕上的对局：谁坐在哪里、本地施法者打了多远、竞技场正在展示什么。
 * 这里的一切都从权威快照投影而来；没有任何内容决定伤害。
 */
export interface Match {
  /**
   * 把一份快照投影到席位、斗士、竞技场读数与瞄准层上。
   * 命中只依据 `CombatEvent` 绘制，并按 `(matchId, seq)` 去重，
   * 因此重新下发房间事件环的重连绝不会重放旧攻击。
   */
  update(snapshot: RoomSnapshot, selfId: string): void;
  /** 本地已确认的前缀：蓄力加上一次击键所绘制的反馈。 */
  typing(progress: number, element: Element): void;
  /** 重新布局后，依据当前游标重绘连接光束与徽记。 */
  relayoutAim(): void;
  /** 当前快照为该用户安排的席位，若未安排则为 undefined。 */
  slotOf(userId: string): number | undefined;
  /** 本地观察者的席位，未入座时为 -1。 */
  readonly selfSlot: number;
  readonly phase: RoomSnapshot['phase'];
  readonly occupancy: readonly (Player | null)[];
  readonly chargeElement: Element;
  readonly selfProgress: number;
}

export function createMatch(wiring: MatchWiring): Match {
  const {
    host,
    fighters,
    seating,
    arena,
    aim,
    assets,
    combat,
    glyphs,
    fx,
    choreography,
    clearEffects,
    relayout,
    paint,
    clock,
    reduced,
  } = wiring;

  const slotByUser = new Map<string, number>();
  const occupancy: (Player | null)[] = Array.from(fighters, () => null);

  let matchId: string | null = null;
  let phase: RoomSnapshot['phase'] = 'lobby';
  let deadline = 0;
  let serverOffset = 0;
  let lastSeq = 0;
  let primed = false;
  let selfId = '';
  let selfSlot = -1;
  let selfSpellLength = 0;
  let selfProgress = 0;
  let chargeElement: Element = 'arcane';
  let spellIndex = 0;
  let lastSeating = '';
  let typingCount = 0;
  let glyphClock = 0;

  const drawEmblem = (): void => {
    aim.drawEmblem(chargeElement, spellIndex, phase, selfSlot);
  };

  /**
   * 按需美术会在请求它的那一帧之后到达：把它装到施法者的徽记上并重绘，
   * 使这次施法不再显示过程化替身。
   */
  assets.onArtArrived = () => {
    drawEmblem();
    paint();
  };

  const ingestEvents = (snapshot: RoomSnapshot): void => {
    const events = snapshot.events ?? [];
    if (!primed) {
      // 一场对局的首个快照绝不重放其事件环，
      // 即使是在战斗中途挂载本舞台的重连场景下也是如此。
      primed = true;
      let highest = lastSeq;
      for (const event of events) {
        if (event.seq > highest) highest = event.seq;
      }
      lastSeq = highest;
      return;
    }
    for (const event of events) {
      if (event.seq <= lastSeq) continue;
      lastSeq = event.seq;
      combat.enqueue(event, clock());
    }
  };

  const reset = (nextMatchId: string | null): void => {
    matchId = nextMatchId;
    lastSeq = 0;
    primed = false;
    lastSeating = '';
    // 新对局不得继承上一局的蓄力：在第一次击键落地之前，
    // 本地施法者显示空轨道。
    selfProgress = 0;
    choreography.reset();
    combat.reset();
    clearEffects();
    for (const fighter of fighters) {
      fighter.setActive(false);
      fighter.setVictory(false);
    }
    aim.clear();
  };

  return {
    get phase(): RoomSnapshot['phase'] {
      return phase;
    },

    get occupancy(): readonly (Player | null)[] {
      return occupancy;
    },

    get chargeElement(): Element {
      return chargeElement;
    },

    get selfProgress(): number {
      return selfProgress;
    },

    update(snapshot: RoomSnapshot, nextSelfId: string): void {
      if (snapshot.matchId !== matchId) reset(snapshot.matchId);

      phase = snapshot.phase;
      deadline = snapshot.deadline;
      serverOffset = snapshot.serverNow - Date.now();
      selfId = nextSelfId;
      host.dataset.phase = phase;

      slotByUser.clear();
      occupancy.fill(null);
      const seated = [...snapshot.players].sort((left, right) => left.slot - right.slot);
      for (const player of seated) {
        if (player.slot < 0 || player.slot >= occupancy.length) continue;
        occupancy[player.slot] = player;
        slotByUser.set(player.id, player.slot);
      }
      host.dataset.seats = String(seated.length);

      const self = slotByUser.get(selfId);
      selfSlot = self ?? -1;
      selfSpellLength = self !== undefined ? (occupancy[self]?.spellLength ?? 0) : 0;
      if (self === undefined) selfProgress = 0;
      chargeElement = snapshot.spell?.element ?? chargeElement;
      spellIndex = self !== undefined ? (occupancy[self]?.spellIndex ?? 0) : 0;
      assets.warmSpell(chargeElement, spellIndex);

      const instant = !primed || reduced();
      for (let slot = 0; slot < occupancy.length; slot += 1) {
        const player = occupancy[slot];
        const fighter = fighters[slot];
        if (!player) {
          fighter.setActive(false);
          continue;
        }
        fighter.setActive(true);
        const state: FighterState = {
          slot,
          connected: player.connected,
          self: player.id === selfId,
          hpRatio: player.maxHp > 0 ? player.hp / player.maxHp : 0,
          eliminated: player.eliminatedAt !== null,
          rank: player.rank,
        };
        const pendingKill = snapshot.events.some(
          (event) => event.seq > lastSeq && event.eliminated && event.targetId === player.id,
        );
        const deferElimination =
          !instant &&
          player.eliminatedAt !== null &&
          !fighter.isDown &&
          // 要么致命弹道已经在飞行中，要么将发射它的那个事件就在这份快照里、
          // 尚未被摄取。
          (pendingKill || combat.incoming(player.id));
        fighter.applyState(state, instant, deferElimination);
        combat.defer(slot, fighter.eliminationPending, clock());
        if (player.id === selfId) {
          fighter.setCharge(selfSpellLength > 0 ? selfProgress / selfSpellLength : 0);
        } else {
          // 对手的蓄力来自权威快照。他们的符文使用斗士自身的元素：
          // 协议不携带远端咒文元素，而读取蓄力也不需要它。
          fighter.setCharge(
            player.spellLength > 0 ? Math.min(1, player.progress / player.spellLength) : 0,
          );
        }
      }

      // 列布局还取决于观看者是谁：观察者始终站在最左列，
      // 因此改变其席位的重新加入即便已占用席位集合没有变化，也必须重新布局。
      const seatingKey = `${selfSlot}|${seated.map((player) => player.slot).join(',')}`;
      if (seatingKey !== lastSeating) {
        lastSeating = seatingKey;
        relayout();
      }
      ingestEvents(snapshot);

      const selfPlayer = self !== undefined ? occupancy[self] : null;
      arena.setDanger(selfPlayer ? 1 - selfPlayer.hp / Math.max(1, selfPlayer.maxHp) : 0);
      const remaining = deadline - (Date.now() + serverOffset);
      arena.setFinalSeconds(phase === 'playing' && remaining > 0 && remaining <= FINAL_SECONDS_MS);
      drawEmblem();
      aim.drawAim(selfSlot, occupancy, phase, chargeElement);
      if (reduced()) {
        arena.update(0);
        paint();
      }
    },

    typing(progress: number, element: Element): void {
      const next = Math.max(0, Math.trunc(progress));
      const gained = next - selfProgress;
      chargeElement = element;
      selfProgress = next;
      if (gained > 0 && selfSlot >= 0) {
        const seat = seating.geometry[selfSlot];
        if (clock() - glyphClock >= GLYPH_MIN_GAP_MS) {
          glyphClock = clock();
          glyphs.emit(element, seat.x + 18, seat.feetY - seat.height * 0.62, Math.min(3, gained));
          fx.typingSpark(seat.x + 18, seat.feetY - seat.height * 0.6, element, Math.min(3, gained));
        }
        // 反馈同时锚定在读数条上：微尘从文字下方落入施法者，
        // 使一次确认击键在竞技场两端都可感知，且不在文字之上绘制任何内容。
        fx.textMotes(seat.x, element, Math.min(4, gained));
        // 可供观察的证据，证明绘制过一次打字效果，供视觉测试使用。
        typingCount += 1;
        host.dataset.typingSeq = String(typingCount);
        host.dataset.typingFx = element;
      }
      if (selfSlot >= 0) {
        fighters[selfSlot].setCharge(selfSpellLength > 0 ? selfProgress / selfSpellLength : 0);
        if (reduced()) fighters[selfSlot].update(0, 0.5);
      }
      glyphs.update(reduced() ? 120 : 0);
      if (reduced()) paint();
    },

    relayoutAim(): void {
      aim.drawAim(selfSlot, occupancy, phase, chargeElement, true);
      drawEmblem();
    },

    slotOf(userId: string): number | undefined {
      return slotByUser.get(userId);
    },

    get selfSlot(): number {
      return selfSlot;
    },
  };
}
