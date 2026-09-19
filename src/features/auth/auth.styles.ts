import * as stylex from '@stylexjs/stylex';

/** Local styles for the WeChat sign-in view. */
export const styles = stylex.create({
  /** The sign-out row keeps its distance from the login link above it. */
  actionsSpaced: {
    marginTop: 14,
  },
  /** The login entry is an anchor wearing the button look; no link underline. */
  link: {
    textDecoration: 'none',
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
