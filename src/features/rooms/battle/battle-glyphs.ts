import { onCleanup, type Accessor } from 'solid-js';
import type { RoomSnapshot } from '../../../../shared/protocol';
import { motion } from '../../../ui/motion';
import type { TypingEffects } from '../../../pixi/typing-effects';
import type { TypingLocalState } from './typing';
import { createGlyphStamp } from './glyph-stamp';

export type CharTone = 'plain' | 'done' | 'ok' | 'cur' | 'err';

/** 对每个已确认的输入位置分类，而不只是第一个出错的前缀。 */
export function charTones(chars: string[], typedChars: string[], settled: boolean): CharTone[] {
  return chars.map((char, index) => {
    if (settled) return 'done';
    if (index < typedChars.length) return typedChars[index] === char ? 'ok' : 'err';
    if (index === typedChars.length) return 'cur';
    return 'plain';
  });
}

/**
 * 分类后的字符既以稳定的钩子（hook）也以 StyleX 类来携带其状态：
 * `ch--ok` / `ch--cur` / `ch--err` / `ch--done` 是读者
 * （以及无障碍工具）一直用来描述字符的名称，
 * 无论样式如何变化，它们都保持有意义。
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
  /** 当受害者的咒文换行超过一行时为 true，这会占用一行高度。 */
  longTarget(): boolean;
  /** 绑定了另一道咒文：尚无任何内容为它庆祝。 */
  arm(index: number): void;
  /** 输入框的采用会在无人打字的情况下移动已确认前缀。 */
  adopt(action: () => void): void;
  /** 每插入一个字符触发一次爆发，包含错误字符；绝不针对临时的 IME 文本。 */
  emit(state: TypingLocalState, index: number): void;
  resize(): void;
}

/**
 * 字形列：绘制在效果画布之上的字符、其换行测量，
 * 以及已确认字符上的粒子爆发。
 * 该图层纯属装饰 —— 缺失、失败或处于减弱动效的图层，
 * 只会改变绘制内容，不会改变任何判定结果。
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
  /** 正在从服务端采用输入框内容时置位，绝不用于打字。 */
  let adopting = false;

  const measure = () => {
    const column = props.column();
    if (!column) return;
    const first = column.firstElementChild;
    if (!(first instanceof HTMLElement)) return;
    const line = first.getBoundingClientRect().height;
    if (line <= 0) return;
    // 一道 39-50 字的硬性咒文会换行为两行，
    // 竞技场会把这一行高度还回去，使输入框与自身状态栏在 900px 屏幕上依然可见。
    longTarget = column.getBoundingClientRect().height > line * 1.5;
  };

  const glyphAt = (index: number): HTMLElement | undefined => {
    const node = props.column()?.children[index];
    return node instanceof HTMLElement ? node : undefined;
  };

  /** 目标字号随视口变化，因此一次尺寸变化可能改变换行。 */
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
      // 删除、服务端采用与重复快照都不是击键。
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
        // 只有出错的字符会抖动；正确字符获得另一种独立的印记。
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
