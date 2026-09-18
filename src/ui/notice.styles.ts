import * as stylex from '@stylexjs/stylex';

/**
 * The shared notice is neutral; views that need a tone or a nested action row
 * compose these on top of `ui.notice`.
 */
export const noticeStyles = stylex.create({
  warn: {
    borderImageSource: 'var(--frame-control)',
    backgroundImage: 'linear-gradient(#7c501b22,#7c501b22),var(--surface-stone)',
    backgroundSize: 'auto,256px 256px',
    backgroundRepeat: 'no-repeat,repeat',
    color: '#ffe4b8',
  },
  /** A notice that carries its own buttons keeps them off its copy. */
  actions: {
    marginTop: 8,
  },
});
