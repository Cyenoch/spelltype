import * as stylex from '@stylexjs/stylex';

export const styles = stylex.create({
  roomHead: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 14,
    flexWrap: 'wrap',
    paddingTop: 0,
    paddingRight: 4,
    paddingBottom: 8,
    paddingLeft: 4,
  },
  phase: {
    fontFamily: 'var(--font-display)',
    fontSize: '1.1rem',
    letterSpacing: '.18em',
    color: 'var(--gold)',
  },
  phaseDim: { color: 'var(--ink-faint)' },
  noticeLayout: {
    display: 'grid',
    gridTemplateColumns: 'auto minmax(0, 1fr) auto',
    alignItems: 'center',
    columnGap: 12,
    rowGap: 12,
    padding: '14px 16px',
    '@media (max-width: 700px)': { gridTemplateColumns: 'auto minmax(0, 1fr)' },
  },
  noticeMessage: { minWidth: 0, overflowWrap: 'anywhere' },
  noticeActions: {
    justifyContent: 'flex-end',
    '@media (max-width: 700px)': { gridColumn: '1 / -1', justifyContent: 'flex-start' },
  },
  noticeError: {
    boxShadow: 'inset 3px 0 #ae5668',
    backgroundImage: 'linear-gradient(#70223933,#70223933),var(--surface-stone)',
    backgroundSize: 'auto,256px 256px',
    backgroundRepeat: 'no-repeat,repeat',
    color: '#ffd8de',
  },
  noticeWarn: {
    borderImageSource: 'var(--frame-control)',
    backgroundImage: 'linear-gradient(#7c501b22,#7c501b22),var(--surface-stone)',
    backgroundSize: 'auto,256px 256px',
    backgroundRepeat: 'no-repeat,repeat',
    color: '#ffe4b8',
  },
});
