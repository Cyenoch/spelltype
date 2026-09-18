import * as stylex from '@stylexjs/stylex';

/**
 * The shared notice is neutral; views that need a tone or a nested action row
 * compose these on top of `ui.notice`.
 */
export const noticeStyles = stylex.create({
  warn: {
    border: '1px solid rgba(255, 196, 108, 0.4)',
    background: 'rgba(48, 34, 12, 0.62)',
    color: '#ffe4b8',
  },
  /** A notice that carries its own buttons keeps them off its copy. */
  actions: {
    marginTop: 8,
  },
});
