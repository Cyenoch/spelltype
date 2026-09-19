import { onCleanup } from 'solid-js';
import * as stylex from '@stylexjs/stylex';
import { motion } from '../../../ui/motion';

const STAMP_DURATION_MS = 360;
const LANDING_OFFSET = 0.72;

/** 可复用的半透明印记；实际字母绝不移动或改变大小。 */
export function createGlyphStamp(): (glyph: HTMLElement) => void {
  const pool: {
    node: HTMLSpanElement;
    ring: HTMLSpanElement;
    animation?: Animation;
    impact?: Animation;
  }[] = [];
  let cursor = 0;
  const clear = () => {
    for (const stamp of pool) {
      stamp.animation?.cancel();
      stamp.impact?.cancel();
      stamp.ring.remove();
      stamp.node.remove();
    }
  };
  const unsubscribe = motion.subscribe((reduced) => {
    if (reduced) clear();
  });
  const pause = () => {
    if (document.hidden) clear();
  };
  document.addEventListener('visibilitychange', pause);
  onCleanup(() => {
    clear();
    unsubscribe();
    document.removeEventListener('visibilitychange', pause);
  });

  return (glyph) => {
    if (motion.reduced || document.hidden) return;
    const character = glyph.firstChild?.textContent ?? '';
    if (character.trim() === '') return;
    const host = glyph.closest<HTMLElement>('[data-spell-surface]');
    if (!host) return;
    const box = glyph.getBoundingClientRect();
    const origin = host.getBoundingClientRect();
    const font = getComputedStyle(glyph);
    let stamp = pool[cursor];
    if (!stamp) {
      const node = document.createElement('span');
      node.className = stylex.props(styles.stamp).className ?? '';
      node.setAttribute('aria-hidden', 'true');
      node.dataset.glyphStamp = 'true';
      const ring = document.createElement('span');
      ring.className = stylex.props(styles.impact).className ?? '';
      ring.setAttribute('aria-hidden', 'true');
      ring.dataset.glyphImpact = 'true';
      stamp = { node, ring };
      pool.push(stamp);
    }
    cursor = (cursor + 1) % 12;
    stamp.animation?.cancel();
    stamp.impact?.cancel();
    const { node, ring } = stamp;
    node.textContent = character;
    node.style.font = font.font;
    node.style.letterSpacing = font.letterSpacing;
    node.style.left = `${box.left - origin.left}px`;
    node.style.top = `${box.top - origin.top}px`;
    node.style.width = `${box.width}px`;
    node.style.height = `${box.height}px`;
    host.appendChild(node);
    stamp.animation = node.animate(
      [
        { opacity: 0.85, transform: 'scale(1.5)' },
        {
          opacity: 0.85,
          transform: 'scale(1.5)',
          offset: 0.15,
          easing: 'cubic-bezier(.55,.05,.8,.45)',
        },
        {
          opacity: 0.95,
          transform: 'scale(1)',
          offset: LANDING_OFFSET,
          easing: 'cubic-bezier(.15,.8,.25,1)',
        },
        { opacity: 0, transform: 'scale(1)' },
      ],
      { duration: STAMP_DURATION_MS, easing: 'linear' },
    );
    stamp.animation.onfinish = () => node.remove();
    const diameter = Math.max(box.width, box.height * 0.45) + 6;
    ring.style.width = `${diameter}px`;
    ring.style.height = `${diameter}px`;
    ring.style.left = `${box.left - origin.left + (box.width - diameter) / 2}px`;
    ring.style.top = `${box.top - origin.top + (box.height - diameter) / 2}px`;
    host.appendChild(ring);
    stamp.impact = ring.animate(
      [
        { opacity: 0.9, transform: 'scale(.45)' },
        { opacity: 0.65, transform: 'scale(1)', offset: 0.3 },
        { opacity: 0, transform: 'scale(1.5)' },
      ],
      { delay: STAMP_DURATION_MS * LANDING_OFFSET, duration: 180, easing: 'ease-out' },
    );
    stamp.impact.onfinish = () => ring.remove();
  };
}

const styles = stylex.create({
  stamp: {
    position: 'absolute',
    pointerEvents: 'none',
    zIndex: 2,
    whiteSpace: 'pre',
    color: 'transparent',
    WebkitTextStrokeWidth: '1px',
    WebkitTextStrokeColor: '#f8f2ff',
    textShadow: '0 0 2px #fff, 0 0 10px var(--glyph-particle-color, var(--arcane))',
    transformOrigin: '50% 50%',
  },
  impact: {
    position: 'absolute',
    pointerEvents: 'none',
    zIndex: 2,
    opacity: 0,
    borderRadius: '50%',
    border: '1px solid #eee9ff',
    boxShadow:
      '0 0 5px var(--glyph-particle-color, var(--arcane)), inset 0 0 4px var(--glyph-particle-color, var(--arcane))',
  },
});
