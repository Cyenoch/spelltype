import * as stylex from '@stylexjs/stylex';

/** Local styles for the sign-in / register view. */
export const styles = stylex.create({
  /** The mode chips sit above the first field. */
  chipsSpaced: {
    marginBottom: 14,
  },
  title: {
    fontSize: 'clamp(1.9rem, 4.4vw, 3rem)',
  },
  h2Size: {
    fontSize: 'clamp(1.35rem, 2.6vw, 1.85rem)',
  },
  /** Body copy keeps the document's paragraph rhythm. */
  paragraph: {
    margin: '0 0 .85em',
  },
});
