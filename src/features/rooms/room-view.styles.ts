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
  roomHeadTitle: { display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' },
  phase: {
    fontFamily: 'var(--font-display)',
    fontSize: '1.1rem',
    letterSpacing: '.18em',
    color: 'var(--gold)',
  },
  phaseDim: { color: 'var(--ink-faint)' },
  loadingText: { margin: 0 },
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
