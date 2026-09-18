import * as stylex from '@stylexjs/stylex';

export const styles = stylex.create({
  root: {
    minWidth: 0,
    marginBottom: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  head: { marginBottom: 0 },
  titleGroup: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    minWidth: 0,
  },
  heading: {
    margin: 0,
    fontSize: '1.12rem',
  },
  statusLine: {
    margin: 0,
    minHeight: '3.3em',
    fontSize: '.86rem',
    color: 'var(--ink-dim)',
  },
  statusDone: { color: 'var(--good)' },
  statusError: { color: '#ffb0be' },
  tiles: {
    margin: 0,
    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
    '@media (max-width: 640px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  },
  tileValueCompact: { fontSize: '1.15rem' },
});
