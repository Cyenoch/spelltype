import * as stylex from '@stylexjs/stylex';

/** Local styles for the private-room form; shared controls, panels and notices come from `ui`. */
export const styles = stylex.create({
  /** The preset strip is part of the theme block below it: a quiet stone shelf
   *  grouping the choice chips so they read as one control cluster. */
  presetRow: {
    marginBottom: 12,
    padding: 12,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-inset)',
    borderImageSlice: 48,
    borderImageWidth: '12px',
    borderImageRepeat: 'stretch',
    borderRadius: 0,
    backgroundColor: '#131022',
    backgroundImage: 'var(--surface-stone)',
    backgroundSize: '256px 256px',
    backgroundRepeat: 'repeat',
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
