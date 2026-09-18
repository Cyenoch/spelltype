import { onCleanup, type Accessor } from 'solid-js';
import type { RoomSnapshot } from '../../../../shared/protocol';
import { motion } from '../../../ui/motion';
import type { TypingEffects } from '../../../pixi/typing-effects';

/** Effects per confirmed commit are capped: fast typing emits repeatedly, not once hugely. */
const MAX_PER_EMIT = 3;

export type CharTone = 'plain' | 'done' | 'ok' | 'cur' | 'err';

/**
 * Character feedback is derived only from the text that may be judged: a settled
 * phase paints every character green, a live one distinguishes the matching
 * prefix, the caret and a mistake. Computed as one run so the class decision
 * never re-enters the text model per character.
 */
export function charTones(
  chars: string[],
  typed: string,
  cursor: number,
  settled: boolean,
): CharTone[] {
  const typedChars = Array.from(typed);
  return chars.map((char, index) => {
    if (settled) return 'done';
    if (index < cursor) return 'ok';
    if (index === cursor) {
      return typedChars[index] !== undefined && typedChars[index] !== char ? 'err' : 'cur';
    }
    return 'plain';
  });
}

/**
 * The classified character carries its state as a stable hook as well as a
 * StyleX class: `ch--ok` / `ch--cur` / `ch--err` / `ch--done` are the names a
 * reader (and the accessibility tooling) has always used to describe a
 * character, and they stay meaningful whatever the styling does.
 */
export function charHook(tone: CharTone | undefined): string {
  if (tone === 'done') return 'ch ch--ok ch--done';
  if (tone === 'ok') return 'ch ch--ok';
  if (tone === 'cur') return 'ch ch--cur';
  if (tone === 'err') return 'ch ch--err';
  return 'ch';
}

export function charTitle(
  tone: CharTone | undefined,
  index: number,
  expected: string | undefined,
): string | undefined {
  return tone === 'err' ? `第 ${index + 1} 个字符应为「${expected}」` : undefined;
}

export interface GlyphFeedback {
  /** True while the victim's spell wraps past one line, which costs a line of height. */
  longTarget(): boolean;
  /** A different spell is bound: nothing is celebrated for it yet. */
  arm(index: number): void;
  /** Field adoptions move the confirmed prefix without anyone typing. */
  adopt(action: () => void): void;
  /** One burst on the glyph the player just confirmed, if it may be celebrated. */
  emit(state: { composing: boolean; progress: number }, index: number): void;
  resize(): void;
}

/**
 * The glyph column: the characters drawn over the effect canvas, their wrap
 * measurement and the particle bursts on confirmed characters. The layer is
 * purely decorative — a missing, failed or reduced-motion layer changes nothing
 * about what is judged, only what is drawn.
 */
export function createGlyphFeedback(props: {
  snapshot: Accessor<RoomSnapshot>;
  selfId: Accessor<string>;
  layer: Accessor<TypingEffects | null>;
  isReady: Accessor<boolean>;
  column: Accessor<HTMLElement | null>;
  fxHost: Accessor<HTMLElement | null>;
}): GlyphFeedback {
  let longTarget = false;
  let targetIndex = 0;
  /** Confirmed prefix already celebrated, for `targetIndex`. */
  let celebrated = 0;
  /** Set while a field is being adopted from the server, never for typing. */
  let adopting = false;

  const measure = () => {
    const column = props.column();
    if (!column) return;
    const first = column.firstElementChild;
    if (!(first instanceof HTMLElement)) return;
    const line = first.getBoundingClientRect().height;
    if (line <= 0) return;
    // A hard 39-50 character spell wraps to two lines, and the arena gives that
    // height back so the input and the self bar stay on a 900px screen.
    longTarget = column.getBoundingClientRect().height > line * 1.5;
  };

  const glyphAt = (index: number): HTMLElement | undefined => {
    const node = props.column()?.children[index];
    return node instanceof HTMLElement ? node : undefined;
  };

  /** The target font is viewport-relative, so a resize can change the wrap. */
  const resize = () => {
    props.layer()?.resize();
    measure();
  };

  window.addEventListener('resize', resize);
  onCleanup(() => window.removeEventListener('resize', resize));

  return {
    longTarget: () => longTarget,
    arm: (index) => {
      targetIndex = index;
      celebrated = 0;
    },
    adopt: (action) => {
      adopting = true;
      try {
        action();
      } finally {
        adopting = false;
      }
    },
    resize,
    emit: (state, index) => {
      if (targetIndex !== index) {
        targetIndex = index;
        celebrated = 0;
      }
      // A composition never advances the celebrated prefix: the provisional text
      // is not judged, so nothing may be celebrated until it is committed.
      const progress = state.composing ? celebrated : Math.max(0, state.progress);
      if (progress === celebrated) return;
      const previous = celebrated;
      celebrated = progress;
      if (progress < previous) return; // retraction: re-arm, celebrate nothing
      if (adopting) return;
      const layer = props.layer();
      if (!layer || !props.isReady() || motion.reduced) return;

      const snapshot = props.snapshot();
      const self = snapshot.players.find((player) => player.id === props.selfId());
      if (snapshot.phase !== 'playing' || !self || self.eliminatedAt !== null) return;

      const fxHost = props.fxHost();
      const glyph = glyphAt(progress - 1);
      if (!glyph || !fxHost) return;
      const hostBox = fxHost.getBoundingClientRect();
      const box = glyph.getBoundingClientRect();
      if (box.width <= 0 && box.height <= 0) return;
      layer.emit(
        box.left - hostBox.left + box.width / 2,
        box.top - hostBox.top + box.height * 0.8,
        snapshot.spell?.element ?? 'arcane',
        Math.min(progress - previous, MAX_PER_EMIT),
      );
    },
  };
}
