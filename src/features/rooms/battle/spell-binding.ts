import type { Element, Player, RoomSnapshot } from '../../../../shared/protocol';
import { spellIconFor } from '../../../pixi/assets';
import type { RestoreMode, TypingRestore, TypingSpellConfig } from './typing';

/** Everything one authoritative snapshot asks the field to do, in order. */
export type SpellBindingOp =
  | { op: 'resetCast' }
  | { op: 'clearField' }
  | { op: 'endField' }
  | { op: 'target'; text: string; artChanged: boolean }
  | { op: 'armGlyphs'; index: number }
  | { op: 'armAim'; element: Element }
  | { op: 'start'; spell: TypingSpellConfig }
  | { op: 'adopt'; restore: TypingRestore; mode: RestoreMode }
  | { op: 'cast'; element: Element | null; hit: boolean }
  | { op: 'focus' };

/**
 * Which spell the field is bound to, and what each snapshot means for it.
 *
 * The binding follows the authoritative identity (match, spellIndex, draft
 * epoch) in that order: an ordinary ack at the same index and epoch never
 * rewrites the field, a snapshot whose index or epoch is older than the bound
 * one cannot touch the target or the field, a larger epoch is a rejection
 * recovery, and a real reconnect re-adopts the same epoch's accepted draft.
 * A committable field only exists while the phase is playing and the snapshot
 * carries a gate with stats: a countdown previews the target only, and a
 * playing snapshot with a missing gate is a corrupt state no field is bound to.
 */
export class SpellBinding {
  private matchId = '';
  private index = -1;
  /** The draft epoch the field is bound to; `-1` when nothing is bound. */
  private epoch = -1;
  private bound = false;
  private target = '';
  private art = '';

  /** The spell index the field is bound to, or `-1` when nothing is bindable. */
  get boundIndex(): number {
    return this.index;
  }

  /** The operations for one snapshot, in the order they must take effect. */
  resolve(
    snapshot: RoomSnapshot,
    self: Player | undefined,
    reconnected: boolean,
  ): SpellBindingOp[] {
    const matchId = snapshot.matchId ?? '';
    const index = self ? self.spellIndex : -1;
    const spell = snapshot.spell;
    const gate = snapshot.selfInputGate;
    const stats = snapshot.selfInputStats;
    const freshMatch = matchId !== this.matchId;
    const ops: SpellBindingOp[] = [];

    if (freshMatch) {
      this.matchId = matchId;
      this.index = -1;
      this.epoch = -1;
      this.bound = false;
      ops.push({ op: 'armGlyphs', index: -1 }, { op: 'resetCast' });
    }

    if (!spell || index < 0) {
      if (this.target) {
        this.target = '';
        ops.push({ op: 'clearField' });
      }
      // Nothing is bindable: the field must stop judging and stop emitting, and
      // the binding must forget its identity so a returning spell rebinds.
      this.bound = false;
      this.epoch = -1;
      ops.push({ op: 'endField' });
      return ops;
    }

    // An identity older than the bound one (a stale or out-of-order snapshot)
    // is ignored before it can touch the target or the field.
    if (!freshMatch && this.index >= 0) {
      if (index < this.index) return ops;
      if (index === this.index && this.bound && gate !== null && gate.draftEpoch < this.epoch) {
        return ops;
      }
    }

    if (spell.text !== this.target) {
      this.target = spell.text;
      const art = spellIconFor(spell.element, index);
      const artChanged = art !== this.art;
      this.art = art;
      ops.push({ op: 'target', text: spell.text, artChanged });
    }

    // A field may only judge with a real gate and its cumulative stats: this is
    // false in countdown (preview only) and in a corrupt gate-less playing state.
    const committable = snapshot.phase === 'playing' && gate !== null && stats !== null;
    const restoreOf = (): TypingRestore => ({
      matchId,
      spellIndex: index,
      draftEpoch: gate!.draftEpoch,
      draft: snapshot.selfInput,
      stats: { attemptTotal: stats!.attemptTotal, errorTotal: stats!.errorTotal },
    });
    const startOf = (): TypingSpellConfig => ({ ...restoreOf(), target: spell.text });

    if (freshMatch || index > this.index) {
      const accepted = this.index >= 0 && index > this.index;
      this.index = index;
      this.epoch = committable ? gate.draftEpoch : -1;
      this.bound = committable;
      // A new spell starts with nothing celebrated, so the cast that produced it
      // and the bind itself can never fire the typing effect. The start carries
      // the spell's accepted draft and the cumulative stats in one step.
      ops.push(
        { op: 'armGlyphs', index },
        // The renderer is armed for the new spell BEFORE the field adopts the
        // draft: resetting after that would strand the meter, the status line
        // and the aim glyph at zero while the field already holds the text.
        { op: 'armAim', element: spell.element },
      );
      if (committable) {
        ops.push(
          { op: 'start', spell: startOf() },
          { op: 'cast', element: spell.element, hit: accepted },
        );
        // Entering combat should not need a click: focus the field once, and
        // only when nothing interactive already holds focus.
        if (!self?.eliminatedAt) ops.push({ op: 'focus' });
      } else {
        ops.push({ op: 'endField' });
      }
      return ops;
    }

    // Same identity from here on.
    if (!committable) {
      this.bound = false;
      ops.push({ op: 'endField' });
      return ops;
    }
    if (!this.bound) {
      // Entering playing with an unchanged index (after the countdown preview,
      // or after a corrupt gate-less state): bind with the actual gate and stats.
      this.epoch = gate.draftEpoch;
      this.bound = true;
      ops.push({ op: 'start', spell: startOf() });
      if (!self?.eliminatedAt) ops.push({ op: 'focus' });
      return ops;
    }
    if (gate.draftEpoch > this.epoch) {
      // A rejection restored the draft under a new epoch: adopt it exactly.
      const restore = restoreOf();
      this.epoch = gate.draftEpoch;
      ops.push({ op: 'adopt', restore, mode: 'recovery' });
      return ops;
    }
    if (reconnected && gate.draftEpoch === this.epoch) {
      // A real reconnect reconciles once with server truth at the same epoch.
      ops.push({ op: 'adopt', restore: restoreOf(), mode: 'reconnect' });
    }
    // Anything else is an ordinary ack at the bound epoch: the field is not
    // rewritten, so a late snapshot can never undo what the player typed.
    return ops;
  }
}
