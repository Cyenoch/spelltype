import * as stylex from '@stylexjs/stylex';

/**
 * Styles for the dedicated spell-generation scene (the authoritative
 * `generating` phase): a floating grimoire inside turning rune rings, so the
 * pause before combat reads as a ritual, never as a stalled blank input screen.
 *
 * Motion follows the queue screen's vocabulary, composed and never overridden:
 * a `*Run` class applies an animation, the reduced-motion preference (mirrored
 * onto `<html>` by motion.ts) drops the animation name entirely so the static
 * scene stays clear, and the shared `paused` class freezes whatever runs where
 * it stands. Every animation moves `transform` or `opacity` only.
 */
const floatY = stylex.keyframes({
  '0%, 100%': { transform: 'translateY(0)' },
  '50%': { transform: 'translateY(-7px)' },
});

const floatShadow = stylex.keyframes({
  '0%, 100%': { transform: 'scaleX(1)', opacity: 0.6 },
  '50%': { transform: 'scaleX(0.9)', opacity: 0.4 },
});

const glow = stylex.keyframes({
  '0%, 100%': { opacity: 0.16 },
  '50%': { opacity: 0.4 },
});

const pulse = stylex.keyframes({
  '0%, 100%': { opacity: 0.5, transform: 'scale(0.97)' },
  '50%': { opacity: 1, transform: 'scale(1.03)' },
});

const spin = stylex.keyframes({
  to: { transform: 'rotate(360deg)' },
});

const spinRev = stylex.keyframes({
  to: { transform: 'rotate(-360deg)' },
});

const twinkle = stylex.keyframes({
  '0%, 100%': { opacity: 0.3 },
  '50%': { opacity: 1 },
});

const breathe = stylex.keyframes({
  '0%, 100%': { transform: 'scale(0.97)', opacity: 0.92 },
  '50%': { transform: 'scale(1.03)', opacity: 1 },
});

const sheen = stylex.keyframes({
  '0%, 100%': { transform: 'translateX(-170%)', opacity: 0 },
  '40%': { opacity: 1 },
  '60%': { transform: 'translateX(170%)', opacity: 0 },
});

const drift = stylex.keyframes({
  '0%': { transform: 'translateY(0)', opacity: 0 },
  '14%': { opacity: 0.55 },
  '78%': { opacity: 0.3 },
  '100%': { transform: 'translateY(-110px)', opacity: 0 },
});

export const styles = stylex.create({
  /* ------------------------------------------------------------- scene --- */

  scene: {
    position: 'relative',
    isolation: 'isolate',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    minHeight: 'clamp(400px, 56vh, 600px)',
    padding: 'clamp(20px, 3.4vw, 44px) clamp(14px, 2.6vw, 34px)',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius)',
    backgroundImage:
      'radial-gradient(120% 90% at 50% -20%, rgba(122, 96, 255, 0.22), transparent 60%), linear-gradient(180deg, rgba(24, 18, 52, 0.66), rgba(9, 7, 22, 0.92))',
    boxShadow: 'var(--shadow)',
  },

  /* The room's own arena, dimmed far into the background. */
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    opacity: 0.16,
    pointerEvents: 'none',
  },

  /* Rising dust motes: purely decorative, spread by per-mote placement. */
  dust: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 0,
    pointerEvents: 'none',
  },

  moteP: {
    position: 'absolute',
    width: 5,
    height: 5,
    borderRadius: '50%',
    background: 'radial-gradient(circle, #fff 0 20%, #a99cff 48%, rgba(106, 88, 255, 0) 74%)',
  },

  p1: {
    left: '10%',
    top: '64%',
    width: 6,
    height: 6,
    animationName: drift,
    animationDuration: '8s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  p2: {
    left: '22%',
    top: '80%',
    animationName: drift,
    animationDuration: '10.5s',
    animationDelay: '1.6s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  p3: {
    left: '78%',
    top: '70%',
    animationName: drift,
    animationDuration: '9s',
    animationDelay: '0.8s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  p4: {
    left: '88%',
    top: '82%',
    animationName: drift,
    animationDuration: '11s',
    animationDelay: '2.4s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  p5: {
    left: '52%',
    top: '88%',
    width: 6,
    height: 6,
    animationName: drift,
    animationDuration: '9.5s',
    animationDelay: '3.2s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  inner: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 'clamp(10px, 1.6vw, 16px)',
    maxWidth: 'min(720px, 100%)',
    textAlign: 'center',
  },

  title: {
    margin: 0,
    fontFamily: 'var(--font-display)',
    fontSize: 'clamp(1.5rem, 3vw, 2.2rem)',
    letterSpacing: '.08em',
    color: 'var(--ink)',
    textShadow: '0 0 26px rgba(159, 146, 255, 0.4)',
    '@media (max-width: 420px)': { fontSize: '1.42rem' },
  },

  /* The one live sentence: who is ready, what the AI is casting together,
     and the countdown that follows — all of it authoritative copy. */
  state: {
    margin: 0,
    maxWidth: 'min(560px, 100%)',
    color: 'var(--ink-dim)',
    fontSize: 'clamp(0.92rem, 1.5vw, 1.02rem)',
    lineHeight: 1.75,
    overflowWrap: 'anywhere',
  },

  /* ------------------------------------------------------------ stage --- */

  stage: {
    position: 'relative',
    display: 'grid',
    placeItems: 'center',
    width: 'clamp(236px, 30vw, 330px)',
    aspectRatio: 1,
    marginTop: 2,
    '@media (max-width: 720px)': { width: 'clamp(212px, 60vw, 280px)' },
  },

  /* Soft light behind the book; opacity-only so centring survives the pulse. */
  aura: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: '66%',
    height: '66%',
    transform: 'translate(-50%, -50%)',
    opacity: 0.28,
    pointerEvents: 'none',
  },

  auraRun: {
    animationName: glow,
    animationDuration: '3.6s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  ring: {
    position: 'absolute',
    borderRadius: '50%',
    pointerEvents: 'none',
  },

  ringBase: {
    top: '4%',
    right: '4%',
    bottom: '4%',
    left: '4%',
    border: '1px solid rgba(159, 146, 255, 0.32)',
    boxShadow: 'inset 0 0 34px rgba(122, 96, 255, 0.16)',
  },

  ringPulseRun: {
    animationName: pulse,
    animationDuration: '3.4s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  /* An energy arc pouring around the book while the pages are being written. */
  ringSweep: {
    top: '4%',
    right: '4%',
    bottom: '4%',
    left: '4%',
    background:
      'conic-gradient(from 0deg, transparent 0 68%, rgba(98, 211, 255, 0.6) 90%, rgba(255, 215, 154, 0.75) 97%, transparent 100%)',
    WebkitMask:
      'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))',
    mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))',
    filter: 'drop-shadow(0 0 10px rgba(98, 211, 255, 0.4))',
    opacity: 0.55,
  },

  ringSweepRun: {
    animationName: spin,
    animationDuration: '9s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  ringInner: {
    top: '15%',
    right: '15%',
    bottom: '15%',
    left: '15%',
    border: '1px dashed rgba(170, 156, 255, 0.38)',
    opacity: 0.8,
  },

  /* Orbiting element glyphs: the wrapper spans the ring so its own rotation
     moves the sigil around the centre; each glyph counter-rotates so the art
     stays upright at every point of the orbit. */
  orbit: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    pointerEvents: 'none',
  },

  orbitRun: {
    animationName: spin,
    animationDuration: '26s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  orbitRevRun: {
    animationName: spinRev,
    animationDuration: '18s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  glyphSlot: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },

  slotB: { transform: 'rotate(90deg)' },
  slotC: { transform: 'rotate(180deg)' },
  slotD: { transform: 'rotate(270deg)' },

  glyphCounter: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },

  glyphCounterRun: {
    animationName: spinRev,
    animationDuration: '26s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  uprightB: { transform: 'rotate(-90deg)' },
  uprightC: { transform: 'rotate(-180deg)' },
  uprightD: { transform: 'rotate(-270deg)' },

  glyphImg: {
    position: 'absolute',
    top: -11,
    left: 'calc(50% - 11px)',
    filter: 'drop-shadow(0 0 8px rgba(159, 146, 255, 0.55))',
  },

  /* Two embers on the counter-orbit; dots, so no uprighting is needed. */
  orbitDot: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    '::before': {
      content: '""',
      position: 'absolute',
      top: -3,
      left: '50%',
      width: 6,
      height: 6,
      marginLeft: -3,
      borderRadius: '50%',
      background: 'radial-gradient(circle, #fff 0 18%, #ffd9a2 46%, rgba(255, 179, 102, 0) 72%)',
    },
  },

  dotB: { transform: 'rotate(140deg)' },

  dotRun: {
    '::before': {
      animationName: twinkle,
      animationDuration: '2.4s',
      animationTimingFunction: 'ease-in-out',
      animationIterationCount: 'infinite',
      '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
    },
  },

  /* ------------------------------------------------------------- book --- */

  book: {
    position: 'relative',
    zIndex: 2,
    width: '40%',
    aspectRatio: '3 / 4.1',
    '@media (max-width: 720px)': { width: '44%' },
  },

  bookRun: {
    animationName: floatY,
    animationDuration: '5.2s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  bookCover: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1,
    display: 'grid',
    placeItems: 'center',
    overflow: 'hidden',
    border: '1px solid rgba(199, 178, 255, 0.4)',
    borderRadius: '10px 14px 14px 10px',
    backgroundImage:
      'linear-gradient(150deg, rgba(66, 50, 108, 0.95), rgba(39, 29, 74, 0.95) 52%, rgba(25, 18, 48, 0.95))',
    boxShadow:
      '0 24px 48px rgba(3, 2, 12, 0.6), inset 0 1px 0 rgba(255, 236, 200, 0.18), inset 0 0 30px rgba(122, 96, 255, 0.18)',
    /* Spine highlight along the bound edge. */
    '::before': {
      content: '""',
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
      width: '14%',
      borderRadius: '10px 0 0 10px',
      backgroundImage:
        'linear-gradient(90deg, rgba(12, 8, 26, 0.85), rgba(255, 236, 200, 0.1) 60%, transparent)',
      pointerEvents: 'none',
    },
  },

  /* A slow light pass across the cover: pages are visibly being written. */
  bookSheen: {
    '::after': {
      content: '""',
      position: 'absolute',
      top: '-20%',
      bottom: '-20%',
      left: 0,
      width: '34%',
      backgroundImage:
        'linear-gradient(105deg, transparent, rgba(240, 225, 255, 0.16) 50%, transparent)',
      transform: 'translateX(-170%)',
      pointerEvents: 'none',
      '@media (prefers-reduced-motion: reduce)': { display: 'none' },
    },
  },

  bookSheenRun: {
    '::after': {
      animationName: sheen,
      animationDuration: '3.8s',
      animationTimingFunction: 'ease-in-out',
      animationIterationCount: 'infinite',
      '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
    },
  },

  bookEmblem: {
    width: '46%',
    borderRadius: 12,
    filter: 'drop-shadow(0 0 16px rgba(159, 146, 255, 0.55))',
  },

  emblemRun: {
    animationName: breathe,
    animationDuration: '4.2s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  /* Page block peeking out on the fore-edge, behind the cover. */
  bookPages: {
    position: 'absolute',
    top: '7%',
    bottom: '7%',
    right: -6,
    zIndex: 0,
    width: 7,
    borderRadius: '0 4px 4px 0',
    backgroundImage: 'repeating-linear-gradient(180deg, #efe7d2 0 2px, #b9ae93 2px 3px)',
    boxShadow: '2px 2px 8px rgba(3, 2, 12, 0.5)',
  },

  /* Grounding shadow; it breathes with the float so the book stays planted. */
  bookShadow: {
    position: 'absolute',
    right: '12%',
    bottom: -16,
    left: '12%',
    height: 16,
    borderRadius: '50%',
    backgroundImage: 'radial-gradient(50% 50% at 50% 50%, rgba(2, 1, 8, 0.55), transparent 72%)',
    opacity: 0.6,
  },

  shadowRun: {
    animationName: floatShadow,
    animationDuration: '5.2s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  /* ------------------------------------------------------------- copy --- */

  trail: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px 24px',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },

  step: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    fontSize: '.88rem',
    color: 'var(--ink-faint)',
    '@media (max-width: 480px)': { fontSize: '.82rem' },
  },

  stepDone: {
    color: 'var(--ink-dim)',
  },

  stepCurrent: {
    color: 'var(--ink)',
    fontWeight: 600,
  },

  marker: {
    flex: 'none',
    fontSize: '.95rem',
    lineHeight: 1,
  },

  markerDone: {
    color: 'var(--good)',
  },

  markerCurrent: {
    color: 'var(--gold)',
    textShadow: '0 0 12px rgba(255, 215, 154, 0.55)',
  },

  theme: {
    margin: 0,
    maxWidth: '100%',
    fontFamily: 'var(--font-display)',
    fontSize: '.95rem',
    letterSpacing: '.04em',
    color: 'var(--gold)',
    overflowWrap: 'anywhere',
  },

  genNotice: {
    width: 'min(560px, 100%)',
    marginBottom: 0,
  },

  actionsRow: {
    justifyContent: 'center',
    marginTop: 2,
  },

  /* The pause toggle is pointless when the preference already dropped all
     motion, so it steps aside exactly like the queue screen's toggle. */
  motionToggle: {
    '@media (prefers-reduced-motion: reduce)': { display: 'none' },
  },

  /**
   * Freezes every running animation where it stands, including the animated
   * pseudo-elements. Composed last, so it needs no `!important`.
   */
  paused: {
    animationPlayState: 'paused',
    '::before': { animationPlayState: 'paused' },
    '::after': { animationPlayState: 'paused' },
  },
});
