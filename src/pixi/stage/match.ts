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

/** Everything the match projection reads and writes. */
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
  /** Drops every live effect and particle: a new match starts from an empty arena. */
  clearEffects: () => void;
  /** Lays the arena out again after the seating changed. */
  relayout: () => void;
  /** Renders one frame and counts it as a paint. */
  paint: () => void;
  /** Frame clock in ms, shared with the ticker. */
  clock: () => number;
  /** True while the arena runs in reduced motion. */
  reduced: () => boolean;
}

/**
 * The match on screen: who sits where, how far the local caster has typed and
 * what the arena is showing. Everything here is projected from the authoritative
 * snapshot; nothing decides damage.
 */
export interface Match {
  /**
   * Projects one snapshot onto the seats, the fighters, the arena readout and the
   * aim. Hits are only drawn from `CombatEvent`s, deduplicated by `(matchId, seq)`,
   * so a reconnect that re-delivers the room's event ring never replays an old
   * attack.
   */
  update(snapshot: RoomSnapshot, selfId: string): void;
  /** The confirmed local prefix: charge plus the feedback one keystroke draws. */
  typing(progress: number, element: Element): void;
  /** Redraws the tether and the emblem from the current cursor, after a relayout. */
  relayoutAim(): void;
  /** The seat the current snapshot put this user in, if it seated them at all. */
  slotOf(userId: string): number | undefined;
  /** The local viewer's slot, or -1 when they are not seated. */
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
   * On-demand art lands after the frame that asked for it: put it on the caster's
   * emblem and repaint, so the cast stops showing its procedural stand-in.
   */
  assets.onArtArrived = () => {
    drawEmblem();
    paint();
  };

  const ingestEvents = (snapshot: RoomSnapshot): void => {
    const events = snapshot.events ?? [];
    if (!primed) {
      // The first snapshot of a match never replays its ring, even on a reconnect
      // that mounts this stage in the middle of a fight.
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
    // A new match must not inherit the previous one's charge: until the first
    // keystroke lands, the local caster shows an empty orbit.
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
          // Either the killing bolt is already in flight, or the event that will
          // launch it is in this very snapshot and has not been ingested yet.
          (pendingKill || combat.incoming(player.id));
        fighter.applyState(state, instant, deferElimination);
        combat.defer(slot, fighter.eliminationPending, clock());
        if (player.id === selfId) {
          fighter.setCharge(selfSpellLength > 0 ? selfProgress / selfSpellLength : 0);
        } else {
          // Opponents charge from the authoritative snapshot. Their runes use
          // the fighter's own element: the protocol carries no remote spell
          // element, and none is needed for a charge read.
          fighter.setCharge(
            player.spellLength > 0 ? Math.min(1, player.progress / player.spellLength) : 0,
          );
        }
      }

      // The column layout also depends on who is looking: the viewer always
      // stands in the leftmost column, so a rejoin that changes their slot must
      // relayout even when the set of occupied seats did not move.
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
        // Feedback anchored to the readout strip as well: motes fall from under
        // the text into the caster, so a confirmed keystroke is legible at both
        // ends of the arena without anything being drawn over the text.
        fx.textMotes(seat.x, element, Math.min(4, gained));
        // Observable proof that a typing effect was drawn, for the visual specs.
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
