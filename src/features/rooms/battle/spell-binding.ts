import type { Element, Player, RoomSnapshot } from '../../../../shared/protocol';
import { spellIconFor } from '../../../pixi/assets';
import type { TypingSpellConfig } from './typing';

/** Everything one authoritative snapshot asks the field to do, in order. */
export type SpellBindingOp =
  | { op: 'resetCast' }
  | { op: 'clearField' }
  | { op: 'endField' }
  | { op: 'target'; text: string; artChanged: boolean }
  | { op: 'armGlyphs'; index: number }
  | { op: 'armAim'; element: Element }
  | { op: 'start'; spell: TypingSpellConfig }
  | { op: 'adopt'; draft: string; mode: 'restore' | 'resync' }
  | { op: 'cast'; element: Element | null; hit: boolean }
  | { op: 'focus' };

/**
 * Which spell the field is bound to, and what each snapshot means for it.
 *
 * The binding follows only the authoritative `spellIndex`: an ordinary ack at
 * the same index never rewrites the field, and a snapshot whose index is older
 * than the local one cannot resurrect a spell the player already finished.
 */
export class SpellBinding {
  private matchId = '';
  private index = -1;
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
    const freshMatch = matchId !== this.matchId;
    const ops: SpellBindingOp[] = [];

    if (freshMatch) {
      this.matchId = matchId;
      this.index = -1;
      this.bound = false;
      ops.push({ op: 'armGlyphs', index: -1 }, { op: 'resetCast' });
    }

    if (!spell || index < 0) {
      if (this.target) {
        this.target = '';
        ops.push({ op: 'clearField' });
      }
      // Nothing is bindable: the field must stop judging and stop emitting.
      ops.push({ op: 'endField' });
      return ops;
    }

    if (spell.text !== this.target) {
      this.target = spell.text;
      const art = spellIconFor(spell.element, index);
      const artChanged = art !== this.art;
      this.art = art;
      ops.push({ op: 'target', text: spell.text, artChanged });
    }

    if (freshMatch || index > this.index) {
      const accepted = this.index >= 0 && index > this.index;
      this.index = index;
      this.bound = true;
      // A new spell starts with nothing celebrated, so the cast that produced it
      // and the bind itself can never fire the typing effect.
      ops.push(
        { op: 'armGlyphs', index },
        // The renderer is armed for the new spell BEFORE the field adopts the
        // server draft: resetting after that would strand the meter, the status
        // line and the aim glyph at zero while the field already holds the text.
        { op: 'armAim', element: spell.element },
        { op: 'start', spell: { matchId, spellIndex: index, target: spell.text } },
        // The accepted draft is adopted once, when the spell opens: a late ack
        // must never rewrite text the player has already edited.
        { op: 'adopt', draft: snapshot.selfInput, mode: 'restore' },
        { op: 'cast', element: spell.element, hit: accepted },
      );
      // Entering combat should not need a click: focus the field once, and only
      // when nothing interactive already holds focus.
      if (snapshot.phase === 'playing' && !self?.eliminatedAt) ops.push({ op: 'focus' });
      return ops;
    }

    if (index < this.index) return ops;

    if (reconnected) {
      // A real reconnect reconciles once with server truth at the same index.
      ops.push({ op: 'adopt', draft: snapshot.selfInput, mode: 'resync' });
      return ops;
    }
    if (!this.bound) {
      this.bound = true;
      ops.push(
        { op: 'start', spell: { matchId, spellIndex: index, target: spell.text } },
        { op: 'adopt', draft: snapshot.selfInput, mode: 'restore' },
      );
    }
    return ops;
  }
}
