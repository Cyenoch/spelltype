import * as stylex from '@stylexjs/stylex';

/** Local styles for the private-room form; shared controls, panels and notices come from `ui`. */
export const styles = stylex.create({
  /** The preset strip is part of the theme block below it. */
  presetRow: {
    marginBottom: 10,
  },

  /** Submitting is the primary action; it is spaced off the fields it depends on. */
  submitRow: {
    marginTop: 16,
  },

  /** The shared `steps` style covers the list itself, not its items. */
  step: {
    marginBottom: '.4em',
  },
});
