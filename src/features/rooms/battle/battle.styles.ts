import * as stylex from '@stylexjs/stylex';

/**
 * Combat-surface styles moved out of the global sheet with the same values and
 * tokens, now scoped to the battle components. Backgrounds and borders are
 * written with longhands only: a shorthand declaration that another style
 * partially overrides through `stylex.props` can drop the shorthand's remaining
 * parts, which would silently lose a border width or a background image.
 */
/**
 * Completed glyphs drift while an elemental gradient sweeps through the strokes.
 * Current and untyped glyphs stay still; per-glyph custom properties vary the
 * completed glyphs' phase and amplitude without layout or per-frame script.
 */
const glyphDriftFlow = stylex.keyframes({
  '0%, 100%': { transform: 'translate3d(0, 0, 0)', backgroundPosition: '0% 50%' },
  '50%': {
    transform: 'translate3d(var(--drift-x, 1.2px), var(--drift-y, -1px), 0)',
    backgroundPosition: '100% 50%',
  },
});

export const styles = stylex.create({
  combat: { display: 'flex', flexDirection: 'column', gap: 10 },
  sideTitle: {
    margin: '0 0 8px',
    fontSize: '.8rem',
    letterSpacing: '.2em',
    textTransform: 'uppercase',
    color: 'var(--ink-faint)',
    paddingBottom: 20,
    backgroundImage: 'var(--ornament-divider)',
    backgroundSize: '240px 18px',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'left bottom',
  },

  /* ---------------------------------------------------------------- notices */

  notices: { display: 'block' },
  noticeTight: { marginBottom: 0 },

  /* ------------------------------------------------------------------ arena */

  arena: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    minHeight: 'clamp(300px, 44vh, 520px)',
    /* Reserve a safe content inset; the scene itself remains full bleed. */
    padding: 26,
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    backgroundImage:
      'radial-gradient(120% 100% at 50% 108%, rgba(70, 54, 150, .34), transparent 66%), linear-gradient(180deg, rgba(14, 11, 32, .9), rgba(6, 5, 14, .94)), var(--surface-stone)',
    backgroundSize: 'auto, auto, 256px 256px',
    backgroundRepeat: 'no-repeat, no-repeat, repeat',
    boxShadow: 'var(--shadow)',
    overflow: 'hidden',
    '::before': {
      content: '""',
      position: 'absolute',
      inset: 0,
      zIndex: 4,
      pointerEvents: 'none',
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'transparent',
      borderImageSource: 'var(--frame-panel)',
      borderImageSlice: 48,
      borderImageWidth: '26px',
      borderImageRepeat: 'stretch',
    },
    '@media (max-height: 860px)': { minHeight: 'clamp(240px, 36vh, 380px)' },
    '@media (max-height: 760px)': { minHeight: 'clamp(200px, 30vh, 300px)' },
    '@media (max-width: 880px)': { minHeight: 'clamp(260px, 40vh, 420px)' },
  },

  /* A wrapped target hands its extra line back so the input stays above the
     fold; the long variant is chosen instead of the base, never on top of it. */
  arenaLong: {
    minHeight: 'calc(clamp(300px, 44vh, 520px) * .86)',
    '@media (max-height: 860px)': { minHeight: 'calc(clamp(240px, 36vh, 380px) * .94)' },
    '@media (max-height: 760px)': { minHeight: 'calc(clamp(200px, 30vh, 300px) * .86)' },
    '@media (max-width: 880px)': { minHeight: 'calc(clamp(300px, 44vh, 520px) * .86)' },
  },

  /* Low-health atmosphere: a red vignette that only appears when it matters. */
  vignette: {
    position: 'absolute',
    inset: 0,
    zIndex: 0,
    pointerEvents: 'none',
    opacity: 0,
    transitionProperty: 'opacity',
    transitionDuration: '400ms',
    transitionTimingFunction: 'ease',
    backgroundImage:
      'radial-gradient(120% 100% at 50% 46%, transparent 42%, rgba(180, 30, 60, .34) 100%)',
  },
  vignetteLow: { opacity: 0.55 },
  vignetteCritical: { opacity: 1 },
  vignetteDown: {
    opacity: 0.8,
    backgroundImage:
      'radial-gradient(120% 100% at 50% 46%, transparent 34%, rgba(30, 26, 52, .6) 100%)',
  },

  /* The seat labels float over the canvas top, one column per fighter: the same
     6% inset and equal-column split the canvas seating uses, so each name sits
     directly above its character's head. */
  arenaSeats: {
    position: 'absolute',
    top: 6,
    right: 0,
    left: 0,
    zIndex: 2,
    display: 'grid',
    gridTemplateColumns: 'repeat(var(--seats, 2), minmax(0, 1fr))',
    alignItems: 'start',
    gap: 8,
    paddingRight: '6%',
    paddingLeft: '6%',
    pointerEvents: 'none',
    '@media (max-width: 880px)': { gap: 6 },
  },

  /* Wraps the canvas and the seat overlay so the labels anchor to the fighters,
     not to the HUD row above them. */
  arenaField: {
    position: 'relative',
    zIndex: 1,
    flex: '1 1 auto',
    minHeight: 220,
  },

  arenaBackdrop: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    zIndex: 0,
    objectFit: 'cover',
    opacity: 0.8,
    filter: 'saturate(1.05) brightness(.85)',
    pointerEvents: 'none',
    maskImage: 'radial-gradient(120% 100% at 50% 40%, #000 34%, transparent 88%)',
  },

  arenaCanvas: {
    position: 'absolute',
    inset: 0,
    pointerEvents: 'none',
  },
  arenaCanvasFailed: {
    borderRadius: 'var(--radius-sm)',
    backgroundImage:
      'repeating-linear-gradient(-45deg, rgba(120, 110, 170, .05) 0 10px, transparent 10px 20px)',
    '::after': {
      content: '"战场画布不可用 · 已用文字显示生命与进度"',
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 12,
      textAlign: 'center',
      fontSize: '.76rem',
      letterSpacing: '.12em',
      color: 'var(--ink-faint)',
    },
  },

  arenaHud: {
    position: 'relative',
    zIndex: 3,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
    alignItems: 'center',
    gap: 12,
    padding: '8px 16px',
    '@media (max-width: 560px)': { padding: '8px 10px', gap: 8 },
  },
  arenaStatus: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
    fontSize: '.8rem',
    color: 'var(--ink)',
    letterSpacing: '.08em',
  },
  arenaStatusDetail: { fontSize: '.7rem', color: 'var(--ink-dim)', letterSpacing: 0 },
  arenaActions: {
    display: 'flex',
    justifySelf: 'end',
    alignItems: 'center',
    gap: 4,
    '@media (max-width: 560px)': { flexDirection: 'column', alignItems: 'stretch', gap: 0 },
  },
  arenaLeave: { justifySelf: 'end', minHeight: 40, color: 'var(--ink-dim)' },

  /* ------------------------------------------------------ overhead labels */

  seatLabel: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 3,
    minWidth: 0,
    textAlign: 'center',
  },
  seatLabelDown: { opacity: 0.62, filter: 'grayscale(.5)' },
  seatName: {
    maxWidth: '100%',
    overflow: 'hidden',
    fontSize: 'clamp(.98rem, 1.5vw, 1.18rem)',
    fontWeight: 700,
    lineHeight: 1.2,
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    color: 'var(--ink)',
    textShadow:
      '0 1px 2px rgba(0, 0, 0, .95), 0 0 18px rgba(0, 0, 0, .9), 0 2px 6px rgba(0, 0, 0, .85)',
  },
  seatNameSelf: { color: 'var(--gold)' },
  seatTags: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minWidth: 0,
  },
  /* Canvas mode keeps this readout for assistive tech only; pure-DOM mode draws
     it as the fallback health and progress display. */
  seatReadout: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    width: '100%',
    minWidth: 0,
    marginTop: 2,
  },
  seatReadoutHp: { display: 'flex', alignItems: 'center', gap: 8 },
  seatCast: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    width: 'min(144px, 100%)',
    padding: '4px 8px',
    borderRadius: 7,
    backgroundColor: 'rgba(6, 5, 14, .72)',
  },
  seatCastText: {
    fontFamily: 'var(--font-mono)',
    fontSize: '.66rem',
    lineHeight: 1.2,
    color: 'var(--ink-dim)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  seatCastReady: { color: 'var(--storm)', textShadow: '0 0 10px rgba(230, 255, 92, .45)' },

  hpbar: {
    position: 'relative',
    flex: '1 1 auto',
    height: 10,
    minWidth: 40,
    borderRadius: 999,
    backgroundColor: 'rgba(6, 5, 14, .85)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--line)',
    overflow: 'hidden',
  },
  hpbarDom: { height: 14 },
  hpbarSelf: { height: 16 },
  hpbarFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 0,
    borderRadius: 999,
    backgroundImage: 'var(--hp)',
    transitionProperty: 'width',
    transitionDuration: '320ms',
    transitionTimingFunction: 'cubic-bezier(.22, .7, .3, 1)',
  },
  hpbarFillLow: { backgroundImage: 'var(--hp-low)' },
  hpbarFillCritical: { backgroundImage: 'var(--hp-critical)' },
  hpbarFillDown: { backgroundImage: 'var(--hp-down)' },
  hpbarText: {
    flex: 'none',
    fontFamily: 'var(--font-mono)',
    fontSize: '.78rem',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--ink-dim)',
  },

  castbar: {
    position: 'relative',
    height: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(6, 5, 14, .8)',
    overflow: 'hidden',
  },
  castbarFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 0,
    borderRadius: 999,
    backgroundImage: 'linear-gradient(90deg, #5b4ad0, #9f92ff)',
    transitionProperty: 'width',
    transitionDuration: '140ms',
    transitionTimingFunction: 'linear',
  },

  mark: {
    flex: 'none',
    fontSize: '.68rem',
    paddingTop: 1,
    paddingRight: 7,
    paddingBottom: 1,
    paddingLeft: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'currentColor',
    letterSpacing: '.06em',
  },
  markTarget: { color: 'var(--fire)' },
  markAim: { color: 'var(--danger)' },
  markDown: { color: 'var(--ink-faint)' },
  markOffline: { color: 'var(--gold)' },

  /* ------------------------------------------------------------------ clock */

  timer: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 3,
    padding: '2px 12px',
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-control)',
    borderImageSlice: 48,
    borderImageWidth: '10px',
    borderImageRepeat: 'stretch',
    minWidth: 96,
    backgroundColor: 'transparent',
    backgroundImage:
      'linear-gradient(rgba(10, 8, 22, .55), rgba(10, 8, 22, .55)), var(--surface-stone)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
  },
  /* Urgency restates the full material stack so the red wash survives above
     the stone texture instead of being painted over by it. */
  timerUrgent: {
    backgroundImage:
      'linear-gradient(rgba(255, 107, 125, .12), rgba(255, 107, 125, .12)), var(--surface-stone)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
  },
  timerValue: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'clamp(1.4rem, 2.4vw, 1.8rem)',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--ink)',
    lineHeight: 1,
  },
  timerValueSoon: { color: 'var(--gold)' },
  timerValueUrgent: { color: 'var(--danger)' },
  timerLabel: {
    fontSize: '.66rem',
    lineHeight: 1.2,
    letterSpacing: '.14em',
    color: 'var(--ink-dim)',
  },

  countdown: {
    position: 'absolute',
    zIndex: 5,
    inset: 0,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: 'rgba(6, 5, 14, .42)',
    pointerEvents: 'none',
  },
  countdownValue: {
    fontFamily: 'var(--font-display)',
    fontSize: 'clamp(3.4rem, 10vw, 6rem)',
    lineHeight: 1,
    color: 'var(--gold)',
    textShadow: '0 0 50px rgba(255, 197, 122, .45)',
  },
  countdownHint: { color: 'var(--ink)', fontSize: '.92rem' },

  /* -------------------------------------------------------- typing station */

  station: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    padding: 'clamp(24px, 2.6vw, 30px)',
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-panel)',
    borderImageSlice: 48,
    borderImageWidth: '26px',
    borderImageRepeat: 'stretch',
    backgroundImage:
      'linear-gradient(180deg, rgba(18, 14, 38, .88), rgba(10, 8, 22, .9)), var(--surface-leather)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
    boxShadow: 'var(--shadow)',
  },
  stationHead: {
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 16,
    flexWrap: 'wrap',
  },
  spellHead: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  spellHeadArt: {
    display: 'inline-flex',
    flex: 'none',
    width: 52,
    height: 52,
    /* Content starts exactly at the 10px frame's inner edge so the spell art
       never paints over the slot's metalwork. */
    paddingTop: 9,
    paddingRight: 9,
    paddingBottom: 9,
    paddingLeft: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-control)',
    borderImageSlice: 48,
    borderImageWidth: '10px',
    borderImageRepeat: 'stretch',
    backgroundColor: 'rgba(6, 5, 14, .7)',
    backgroundImage: 'var(--surface-leather)',
    backgroundSize: '256px 256px',
    backgroundRepeat: 'repeat',
    overflow: 'hidden',
  },
  spellArt: { width: '100%', height: '100%', objectFit: 'cover' },
  spellIcon: { width: 30, height: 30 },
  spellName: {
    fontFamily: 'var(--font-display)',
    fontSize: 'clamp(1.15rem, 2.4vw, 1.5rem)',
    color: 'var(--ink)',
    letterSpacing: '.06em',
  },
  elementTag: {
    fontSize: '.78rem',
    paddingTop: 2,
    paddingRight: 10,
    paddingBottom: 2,
    paddingLeft: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'currentColor',
    color: 'var(--arcane)',
  },

  stationProgress: { display: 'flex', alignItems: 'center', gap: 10, minWidth: 'min(320px, 100%)' },
  meter: {
    position: 'relative',
    flex: '1 1 auto',
    height: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--line)',
    backgroundColor: 'rgba(6, 5, 14, .8)',
    overflow: 'hidden',
  },
  meterSpell: { height: 12, borderColor: 'var(--line-strong)' },
  meterFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 0,
    borderRadius: 999,
    backgroundImage: 'linear-gradient(90deg, #4b3ca6, #9f92ff)',
    transitionProperty: 'width',
    transitionDuration: '120ms',
    transitionTimingFunction: 'linear',
  },
  meterText: {
    flex: 'none',
    fontFamily: 'var(--font-mono)',
    fontSize: '.82rem',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--ink-dim)',
  },

  /* The target readout, the invisible native field and the decorative particle
     layer share one box. */
  stationTarget: {
    position: 'relative',
    overflow: 'visible',
    minHeight: 'calc(clamp(1.5rem, 2.05vw, 1.85rem) * 1.6 + 26px)',
  },
  /* Wraps exactly the spell text box so the field can float over it and the
     focus ring can hug it: the ring appears whenever the hidden field inside
     has focus, which is the "you can type here" affordance. */
  spellSurface: {
    position: 'relative',
    borderRadius: 0,
    ':focus-within': {
      boxShadow: '0 0 0 2px rgba(159, 146, 255, .55), 0 0 26px rgba(159, 146, 255, .16)',
    },
  },
  targetFx: {
    position: 'absolute',
    top: -80,
    right: -64,
    bottom: -80,
    left: -64,
    zIndex: 2,
    pointerEvents: 'none',
    overflow: 'visible',
    '@media (max-width: 640px)': { left: -20, right: -20 },
  },
  targetFxFailed: { display: 'none' },

  spellText: {
    fontSize: 'clamp(1.5rem, 2.05vw, 1.85rem)',
    lineHeight: 1.6,
    letterSpacing: '.02em',
    wordBreak: 'break-word',
    whiteSpace: 'break-spaces',
    paddingTop: 12,
    paddingRight: 14,
    paddingBottom: 12,
    paddingLeft: 14,
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-inset)',
    borderImageSlice: 48,
    borderImageWidth: '12px',
    borderImageRepeat: 'stretch',
    backgroundColor: 'transparent',
    backgroundImage:
      'linear-gradient(rgba(5, 4, 12, .78), rgba(5, 4, 12, .78)), var(--surface-stone)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
    userSelect: 'none',
  },
  spellTextCompact: { lineHeight: 1.5 },
  /* The subdued Chinese meaning line under the English spell text. */
  spellTranslation: {
    margin: '6px 0 0',
    fontSize: '.85rem',
    lineHeight: 1.5,
    color: 'var(--ink-dim)',
  },

  /*
   * Inline blocks let completed glyphs drift without touching layout. Current
   * and untyped glyphs have no animation; only chFlow enables the motion.
   */
  ch: {
    display: 'inline-block',
    color: '#85858f',
    transitionProperty: 'color',
    transitionDuration: '120ms',
    transitionTimingFunction: 'ease',
  },
  chOk: { color: 'var(--ink)', textShadow: '0 0 12px rgba(159, 146, 255, .35)' },
  chCur: {
    color: 'var(--storm)',
    borderBottomWidth: 3,
    borderBottomStyle: 'solid',
    borderBottomColor: 'var(--storm)',
    '@media (prefers-reduced-motion: reduce)': { borderBottomWidth: 2 },
  },
  chErr: {
    color: '#ffd8de',
    backgroundColor: 'rgba(255, 107, 125, .26)',
    borderRadius: 4,
    boxShadow: 'inset 0 -2px 0 var(--danger)',
  },
  chDone: { color: 'var(--good)', textShadow: '0 0 14px rgba(100, 230, 176, .4)' },

  /*
   * Flowing elemental fill for completed glyphs: the gradient is clipped to the
   * stroke shapes and sweeps with the drift, and the glow stays restrained.
   * `chFlow` carries the shared mechanics and must always be paired with one
   * element class — alone it would leave transparent text without a fill. The
   * neutral `chOk`/`chDone` tones above remain the between-spells fallback.
   */
  chFlow: {
    color: 'transparent',
    textShadow: 'none',
    backgroundSize: '220% 100%',
    WebkitBackgroundClip: 'text',
    backgroundClip: 'text',
    animationName: glyphDriftFlow,
    animationDuration: 'var(--drift-dur, 6s)',
    animationDelay: 'var(--drift-delay, 0s)',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },
  chFlowArcane: {
    backgroundImage: 'linear-gradient(105deg, #d9d2ff, #9f92ff 32%, #eee9ff 52%, #7f6ee8 78%)',
    filter: 'drop-shadow(0 0 6px rgba(159, 146, 255, .4))',
  },
  chFlowFire: {
    backgroundImage: 'linear-gradient(105deg, #ffd9a8, #ff8a4c 32%, #ffe6c2 52%, #f0641e 78%)',
    filter: 'drop-shadow(0 0 6px rgba(255, 138, 76, .4))',
  },
  chFlowIce: {
    backgroundImage: 'linear-gradient(105deg, #c9ecff, #62d3ff 32%, #ddf4ff 52%, #2ea6e6 78%)',
    filter: 'drop-shadow(0 0 6px rgba(98, 211, 255, .4))',
  },
  chFlowStorm: {
    backgroundImage: 'linear-gradient(105deg, #f6ffc4, #e6ff5c 32%, #fbffd9 52%, #b8c22e 78%)',
    filter: 'drop-shadow(0 0 6px rgba(230, 255, 92, .34))',
  },

  typeArea: { display: 'flex', flexDirection: 'column', gap: 6 },
  /*
   * The native field floats invisibly over the glyphs it drives: same metrics
   * as `spellText` (size, leading, tracking, padding) so the IME candidate
   * window anchors where the player is actually typing. Everything visible —
   * caret included — is drawn by the glyph run underneath; the selection is
   * kept transparent so edits never paint a stray box over the spell.
   */
  typeField: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1,
    width: '100%',
    height: '100%',
    margin: 0,
    borderWidth: 0,
    borderStyle: 'none',
    paddingTop: 12,
    paddingRight: 14,
    paddingBottom: 12,
    paddingLeft: 14,
    fontSize: 'clamp(1.5rem, 2.05vw, 1.85rem)',
    lineHeight: 1.6,
    letterSpacing: '.02em',
    resize: 'none',
    overflow: 'hidden',
    backgroundColor: 'transparent',
    color: 'transparent',
    caretColor: 'transparent',
    outlineStyle: 'none',
    cursor: 'text',
    '::selection': { backgroundColor: 'transparent' },
  },
  typeFieldLocked: { cursor: 'not-allowed' },
  typeAreaRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '8px 18px',
    flexWrap: 'wrap',
    minHeight: '1.5em',
  },
  tip: { margin: 0 },
  inputStatus: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 14,
    fontSize: '.85rem',
    color: 'var(--ink-dim)',
  },
  /*
   * The input gate line: one quiet row that renders the server's rule state.
   * The countdown text updates on the room tick without any live region; only
   * the rejection explanation below is announced.
   */
  inputGate: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    gap: '2px 12px',
    fontSize: '.85rem',
    color: 'var(--gold)',
  },
  inputGateAlert: { color: 'var(--danger)' },
  inputGateText: { margin: 0 },
  inputGateReason: { margin: 0, color: 'var(--ink-dim)' },
  pasteNotice: { fontSize: '.85rem', color: 'var(--gold)' },
  pasteNoticeEmpty: { display: 'none' },
  /* Mirrors the provisional IME composition that the invisible field hides. */
  composingChip: {
    display: 'inline-flex',
    alignSelf: 'flex-start',
    alignItems: 'center',
    maxWidth: '100%',
    overflow: 'hidden',
    paddingTop: 2,
    paddingRight: 10,
    paddingBottom: 2,
    paddingLeft: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'rgba(255, 197, 122, .4)',
    backgroundColor: 'rgba(64, 46, 12, .4)',
    fontFamily: 'var(--font-mono)',
    fontSize: '.82rem',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    color: 'var(--gold)',
  },
  typeHint: { margin: 0, color: 'var(--ink-faint)' },
  castFeedback: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    fontSize: '.88rem',
    color: 'var(--good)',
    minHeight: '1.4em',
  },
  castFeedbackIdle: { color: 'var(--ink-faint)' },
  castFeedbackPending: { color: 'var(--gold)' },
  /* Composed over ui.notice, which now carries a material background: the red
     state cue must restate the full stack or the stone texture paints over it. */
  eliminatedNotice: {
    borderColor: 'rgba(255, 107, 125, .5)',
    backgroundImage:
      'linear-gradient(rgba(52, 16, 26, .78), rgba(52, 16, 26, .78)), var(--surface-stone)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
    backgroundColor: 'transparent',
    color: '#ffd8de',
    alignItems: 'center',
  },

  selfbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    flexWrap: 'wrap',
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: 'var(--line)',
  },
  selfbarHp: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    minWidth: 'min(360px, 100%)',
    flex: '1 1 320px',
  },
  selfbarLabel: {
    flex: 'none',
    fontSize: '.8rem',
    letterSpacing: '.12em',
    color: 'var(--ink-faint)',
  },
  selfbarStats: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 16,
    fontSize: '.84rem',
    color: 'var(--ink-faint)',
    '@media (max-width: 560px)': { gap: 10 },
  },
  selfbarStat: {
    fontFamily: 'var(--font-mono)',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--ink)',
    fontSize: '.95rem',
  },

  /* ------------------------------------------------------------- combat log */

  side: {
    padding: 'clamp(14px, 1.8vw, 18px)',
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-inset)',
    borderImageSlice: 48,
    borderImageWidth: '12px',
    borderImageRepeat: 'stretch',
    backgroundColor: 'rgba(14, 11, 30, .7)',
    backgroundImage: 'var(--surface-stone)',
    backgroundSize: '256px 256px',
    backgroundRepeat: 'repeat',
  },
  log: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' },
  logEntry: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto auto auto',
    alignItems: 'baseline',
    gap: 10,
    paddingTop: 5,
    paddingRight: 8,
    paddingBottom: 5,
    paddingLeft: 8,
    borderRadius: 8,
    fontSize: '.84rem',
    backgroundColor: 'rgba(8, 6, 18, .5)',
    '@media (max-width: 560px)': { gridTemplateColumns: 'minmax(0, 1fr) auto auto' },
  },
  logText: {
    minWidth: 0,
    color: 'var(--ink-dim)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  logDamage: { fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--fire)' },
  logDamageIce: { color: 'var(--ice)' },
  logDamageStorm: { color: 'var(--storm)' },
  logDamageArcane: { color: 'var(--arcane)' },
  logHp: {
    fontFamily: 'var(--font-mono)',
    fontSize: '.78rem',
    color: 'var(--ink-faint)',
    fontVariantNumeric: 'tabular-nums',
    '@media (max-width: 560px)': { display: 'none' },
  },

  /* ---------------------------------------------------------------- results */

  results: {
    display: 'flex',
    flexDirection: 'column',
    gap: 14,
    padding: 'clamp(22px, 2.6vw, 30px)',
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-panel)',
    borderImageSlice: 48,
    borderImageWidth: '26px',
    borderImageRepeat: 'stretch',
    backgroundImage:
      'linear-gradient(180deg, rgba(20, 16, 44, .9), rgba(10, 8, 22, .92)), var(--surface-vellum)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
    boxShadow: 'var(--shadow)',
  },
  result: {
    padding: 'clamp(20px, 4vw, 40px)',
    textAlign: 'center',
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-accent)',
    borderImageSlice: 48,
    borderImageWidth: '16px',
    borderImageRepeat: 'stretch',
    backgroundColor: 'transparent',
    /* The verdict stamped on a seal: the watermark sits behind the title and
       every outcome variant restates this layer stack over its own material. */
    backgroundImage:
      'linear-gradient(180deg, rgba(10, 8, 20, .35), rgba(8, 6, 16, .55)), var(--ornament-seal), var(--surface-stone)',
    backgroundSize: 'auto, 96px 98px, 256px 256px',
    backgroundPosition: 'center, center 24%, center',
    backgroundRepeat: 'no-repeat, no-repeat, repeat',
  },
  resultWin: {
    borderColor: 'rgba(255, 215, 154, .6)',
    backgroundImage:
      'linear-gradient(135deg, rgba(92, 66, 16, .6), rgba(20, 15, 34, .85)), var(--ornament-seal), var(--surface-leather)',
    backgroundSize: 'auto, 96px 98px, 256px 256px',
    backgroundPosition: 'center, center 24%, center',
    backgroundRepeat: 'no-repeat, no-repeat, repeat',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    boxShadow: '0 0 42px rgba(255, 197, 122, .22)',
  },
  resultDown: {
    borderColor: 'rgba(255, 107, 125, .5)',
    backgroundImage:
      'linear-gradient(135deg, rgba(64, 18, 30, .62), rgba(18, 12, 26, .85)), var(--ornament-seal), var(--surface-leather)',
    backgroundSize: 'auto, 96px 98px, 256px 256px',
    backgroundPosition: 'center, center 24%, center',
    backgroundRepeat: 'no-repeat, no-repeat, repeat',
    backgroundColor: 'rgba(0, 0, 0, 0)',
  },
  resultDraw: {
    borderColor: 'rgba(98, 211, 255, .5)',
    backgroundImage:
      'linear-gradient(135deg, rgba(20, 55, 72, .65), rgba(18, 12, 26, .85)), var(--ornament-seal), var(--surface-leather)',
    backgroundSize: 'auto, 96px 98px, 256px 256px',
    backgroundPosition: 'center, center 24%, center',
    backgroundRepeat: 'no-repeat, no-repeat, repeat',
  },
  resultTitle: {
    margin: '0 0 4px',
    fontSize: 'clamp(2.8rem, 7vw, 5rem)',
    letterSpacing: '.1em',
    outlineStyle: 'none',
  },
  resultTitleWin: { color: 'var(--gold)' },
  resultDetail: { margin: 0, color: 'var(--ink-dim)', fontSize: '.9rem' },
  resultRank: { margin: '8px 0 16px', color: 'var(--ink)', fontSize: '1.1rem' },
  resultActions: { justifyContent: 'center' },
  cellSelf: { backgroundColor: 'rgba(255, 215, 154, .08)', color: 'var(--gold)' },
  cellDown: { color: 'var(--ink-faint)' },
  cellRankFirst: { color: 'var(--gold)' },
  rankMedal: { fontWeight: 700 },
  rankMedalFirst: { color: 'var(--gold)' },
  rankMedalSecond: { color: '#d7dcff' },
  rankMedalThird: { color: '#e5a978' },
});
