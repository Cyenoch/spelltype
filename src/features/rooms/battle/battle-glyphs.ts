import { onCleanup, type Accessor } from 'solid-js';
import type { RoomSnapshot } from '../../../../shared/protocol';
import { motion } from '../../../ui/motion';
import type { TypingEffects } from '../../../pixi/typing-effects';
import type { TypingLocalState } from './typing';
import { createGlyphStamp } from './glyph-stamp';

export type CharTone = 'plain' | 'done' | 'ok' | 'cur' | 'err';

/** Classify every confirmed input position, not just the first broken prefix. */
export function charTones(chars: string[], typedChars: string[], settled: boolean): CharTone[] {
  return chars.map((char, index) => {
    if (settled) return 'done';
    if (index < typedChars.length) return typedChars[index] === char ? 'ok' : 'err';
    if (index === typedChars.length) return 'cur';
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
  actual: string | undefined,
): string | undefined {
  if (tone !== 'err') return undefined;
  const entered = actual === ' ' ? '空格' : actual;
  if (expected === undefined) return `第 ${index + 1} 字：多余字符「${entered}」，请退格删除`;
  return `第 ${index + 1} 字：输入了「${entered}」，应输入「${expected === ' ' ? '空格' : expected}」`;
}

export interface GlyphFeedback {
  /** True while the victim's spell wraps past one line, which costs a line of height. */
  longTarget(): boolean;
  /** A different spell is bound: nothing is celebrated for it yet. */
  arm(index: number): void;
  /** Field adoptions move the confirmed prefix without anyone typing. */
  adopt(action: () => void): void;
  /** One burst per inserted character, including mistakes; never provisional IME text. */
  emit(state: TypingLocalState, index: number): void;
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
  const stampGlyph = createGlyphStamp();
  let longTarget = false;
  let targetIndex = 0;
  let observedText = '';
  let observedAttempts = 0;
  const kicks = new Map<HTMLElement, Animation>();
  const clearKicks = () => {
    for (const animation of kicks.values()) animation.cancel();
    kicks.clear();
  };
  const unsubscribeMotion = motion.subscribe((reduced) => {
    if (reduced) clearKicks();
  });
  onCleanup(() => {
    unsubscribeMotion();
    clearKicks();
  });
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
      observedText = '';
      observedAttempts = 0;
      clearKicks();
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
        observedText = '';
        observedAttempts = 0;
        clearKicks();
      }
      if (state.composing) return;
      const previousText = observedText;
      const inserted = state.attempts - observedAttempts;
      observedText = state.text;
      observedAttempts = state.attempts;
      // Deletions, server adoptions and repeated snapshots are not keystrokes.
      if (inserted <= 0 || adopting || motion.reduced) return;
      const snapshot = props.snapshot();
      const self = snapshot.players.find((player) => player.id === props.selfId());
      if (snapshot.phase !== 'playing' || !self || self.eliminatedAt !== null) return;
      const fxHost = props.fxHost();
      if (!fxHost || !snapshot.spell) return;
      const before = Array.from(previousText);
      const after = Array.from(state.text);
      const expected = Array.from(snapshot.spell.text);
      let start = 0;
      while (start < before.length && start < after.length && before[start] === after[start])
        start += 1;
      const hostBox = fxHost.getBoundingClientRect();
      const layer = props.isReady() ? props.layer() : null;
      for (let offset = 0; offset < inserted; offset += 1) {
        const charIndex = start + offset;
        const glyph = glyphAt(Math.min(charIndex, expected.length - 1));
        if (!glyph) continue;
        const box = glyph.getBoundingClientRect();
        if (box.width <= 0 && box.height <= 0) continue;
        const error = after[charIndex] !== expected[charIndex];
        layer?.emit(
          box.left - hostBox.left + box.width / 2,
          box.top - hostBox.top + box.height / 2,
          snapshot.spell.element,
          error,
        );
        if (!error) {
          stampGlyph(glyph);
          continue;
        }
        // Only wrong characters shake; correct characters receive a separate imprint.
        kicks.get(glyph)?.cancel();
        const kick = glyph.animate(
          [{ translate: '-2px 0' }, { translate: '2px 0' }, { translate: '0 0' }],
          { duration: 180, easing: 'ease-out' },
        );
        kicks.set(glyph, kick);
        kick.onfinish = () => {
          if (kicks.get(glyph) === kick) kicks.delete(glyph);
        };
      }
    },
  };
}
