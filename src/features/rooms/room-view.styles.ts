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
    borderColor: 'rgba(255, 107, 125, .45)',
    backgroundColor: 'rgba(56, 18, 28, .62)',
    color: '#ffd8de',
  },
  noticeWarn: {
    borderColor: 'rgba(255, 196, 108, .4)',
    backgroundColor: 'rgba(48, 34, 12, .62)',
    color: '#ffe4b8',
  },
});
