/**
 * StyleX port of the retired `queue.css`.
 *
 * Every value below is copied from that stylesheet: the share of the theme that lives in
 * CSS variables is still referenced by name (`var(--ink)`, …), and the compound selectors
 * the old file used as hooks (`.duelist--self .duelist__art`, `[data-state="waiting"] …`)
 * are resolved at the JSX call site, where the state that drove them already lives.
 *
 * Motion has three states and they are composed, never overridden:
 * `waiting` applies an animation, `paused` freezes whatever is running, and the reduced
 * preference (mirrored onto <html> by motion.ts) drops the animation name entirely.
 */
import * as stylex from '@stylexjs/stylex';

const spin = stylex.keyframes({
  to: { transform: 'rotate(360deg)' },
});

const pulse = stylex.keyframes({
  '0%, 100%': { opacity: 0.5, transform: 'scale(0.97)' },
  '50%': { opacity: 1, transform: 'scale(1.03)' },
});

const breathe = stylex.keyframes({
  '0%, 100%': { opacity: 0.92, transform: 'scale(0.98)' },
  '50%': { opacity: 1, transform: 'scale(1.04)' },
});

const twinkle = stylex.keyframes({
  '0%, 100%': { opacity: 0.35 },
  '50%': { opacity: 1 },
});

const glow = stylex.keyframes({
  '0%, 100%': { opacity: 0.18 },
  '50%': { opacity: 0.4 },
});

const scan = stylex.keyframes({
  '0%, 100%': { transform: 'translateY(-45%)', opacity: 0 },
  '50%': { transform: 'translateY(45%)', opacity: 1 },
});

const sweep = stylex.keyframes({
  '0%, 100%': { transform: 'translateX(-24%)', opacity: 0 },
  '50%': { transform: 'translateX(24%)', opacity: 1 },
});

export const styles = stylex.create({
  /* ------------------------------------------------------------ stage --- */

  stage: {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
    alignItems: 'center',
    justifyItems: 'center',
    rowGap: 'clamp(10px, 2.2vw, 28px)',
    columnGap: 'clamp(10px, 2.2vw, 28px)',
    padding: 'clamp(18px, 3.2vw, 40px) clamp(14px, 2.6vw, 34px)',
    marginBottom: 18,
    border: '1px solid var(--line-strong)',
    borderRadius: 'calc(var(--radius) + 6px)',
    backgroundImage:
      "radial-gradient(120% 130% at 50% -30%, rgba(122, 96, 255, 0.24), transparent 62%), linear-gradient(180deg, rgba(24, 18, 52, 0.72), rgba(9, 7, 22, 0.94)), url('/assets/arenas/arena-1.webp')",
    backgroundPosition: '0% 0%, 0% 0%, center',
    backgroundSize: 'auto, auto, cover',
    boxShadow: 'var(--shadow), var(--glow)',
    overflow: 'hidden',
    isolation: 'isolate',
    '@media (max-width: 720px)': {
      gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
      gridTemplateAreas: '"self rival" "sigil sigil"',
      rowGap: 20,
    },
    '@media (max-width: 420px)': { padding: '16px 12px' },
  },

  /* Faint arena ring, so the stage reads as a place rather than a card. */
  stageRing: {
    '::after': {
      content: '""',
      position: 'absolute',
      left: '50%',
      bottom: '-72%',
      width: 'min(680px, 132%)',
      aspectRatio: 1,
      transform: 'translateX(-50%)',
      borderRadius: '50%',
      border: '1px solid rgba(150, 136, 255, 0.12)',
      boxShadow: 'inset 0 0 140px rgba(122, 96, 255, 0.12)',
      pointerEvents: 'none',
      zIndex: -1,
    },
  },

  /* The travelling sheen only exists while the search is live. */
  stageSheen: {
    '::before': {
      content: '""',
      position: 'absolute',
      top: '-30%',
      right: '-12%',
      bottom: '-30%',
      left: '-12%',
      backgroundImage:
        'linear-gradient(112deg, transparent 42%, rgba(159, 146, 255, 0.1) 50%, transparent 58%)',
      pointerEvents: 'none',
      animationName: sweep,
      animationDuration: '7s',
      animationTimingFunction: 'ease-in-out',
      animationIterationCount: 'infinite',
      '@media (prefers-reduced-motion: reduce)': { animationName: 'none', display: 'none' },
    },
  },

  /* --------------------------------------------------------- duelists --- */

  duelist: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
    textAlign: 'center',
  },

  duelistSelf: {
    '@media (max-width: 720px)': { gridArea: 'self' },
  },

  duelistRival: {
    '@media (max-width: 720px)': { gridArea: 'rival' },
  },

  /* A settled screen is visibly not searching. */
  duelistRivalSettled: {
    opacity: 0.6,
  },

  art: {
    position: 'relative',
    display: 'grid',
    placeItems: 'center',
    width: 'clamp(92px, 14vw, 130px)',
    aspectRatio: 1,
    border: '1px solid var(--line-strong)',
    borderRadius: '50%',
    background:
      'radial-gradient(72% 72% at 50% 28%, rgba(159, 146, 255, 0.26), rgba(10, 8, 24, 0.92))',
    '@media (max-width: 420px)': { width: 'clamp(76px, 26vw, 100px)' },
  },

  selfArt: {
    borderColor: 'rgba(255, 215, 154, 0.55)',
    boxShadow: '0 0 34px rgba(255, 215, 154, 0.18), inset 0 0 30px rgba(255, 215, 154, 0.12)',
  },

  rivalArt: {
    borderStyle: 'dashed',
    borderColor: 'rgba(150, 136, 255, 0.34)',
    background:
      'radial-gradient(72% 72% at 50% 28%, rgba(92, 82, 142, 0.24), rgba(8, 7, 18, 0.95))',
    overflow: 'hidden',
  },

  crest: {
    width: '58%',
    height: '58%',
    borderRadius: 14,
    objectFit: 'contain',
  },

  selfCrest: {
    width: '100%',
    height: '100%',
    borderRadius: '50%',
    objectFit: 'cover',
  },

  rivalCrest: {
    opacity: 0.8,
    filter: 'blur(2.5px) saturate(0.6) brightness(0.85)',
  },

  /* The unnamed opponent: a veil that scans, never a fabricated portrait. */
  veil: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: '50%',
    background: 'linear-gradient(180deg, rgba(9, 7, 22, 0.16), rgba(9, 7, 22, 0.55))',
    overflow: 'hidden',
    '::after': {
      content: '""',
      position: 'absolute',
      top: '-60%',
      right: 0,
      bottom: '-60%',
      left: 0,
      background:
        'linear-gradient(180deg, transparent 38%, rgba(159, 146, 255, 0.3) 50%, transparent 62%)',
      '@media (prefers-reduced-motion: reduce)': { opacity: 0.5, transform: 'translateY(0)' },
    },
  },

  veilScan: {
    '::after': {
      animationName: scan,
      animationDuration: '2.7s',
      animationTimingFunction: 'ease-in-out',
      animationIterationCount: 'infinite',
      '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
    },
  },

  unknown: {
    position: 'relative',
    fontFamily: 'var(--font-display)',
    fontSize: 'clamp(1.9rem, 4vw, 2.7rem)',
    lineHeight: 1,
    color: 'var(--ink-dim)',
    textShadow: '0 0 20px rgba(159, 146, 255, 0.65)',
  },

  duelistBody: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
    maxWidth: '100%',
  },

  tag: {
    padding: '1px 10px',
    border: '1px solid var(--line)',
    borderRadius: 999,
    fontSize: '.72rem',
    letterSpacing: '.18em',
    color: 'var(--ink-faint)',
  },

  selfTag: {
    borderColor: 'rgba(255, 215, 154, 0.45)',
    color: 'var(--gold)',
  },

  name: {
    maxWidth: '100%',
    fontWeight: 600,
    fontSize: 'clamp(1rem, 1.6vw, 1.16rem)',
    lineHeight: 1.3,
    color: 'var(--ink)',
    overflowWrap: 'anywhere',
    '@media (max-width: 420px)': { fontSize: '.98rem' },
  },

  nameUnknown: {
    letterSpacing: '.3em',
    color: 'var(--ink-faint)',
  },

  note: {
    fontSize: '.8rem',
    color: 'var(--ink-faint)',
    '@media (max-width: 420px)': { fontSize: '.75rem' },
  },

  /* ------------------------------------------------------------ sigil --- */

  sigil: {
    position: 'relative',
    zIndex: 1,
    display: 'grid',
    placeItems: 'center',
    width: 'clamp(168px, 22vw, 244px)',
    aspectRatio: 1,
    '@media (max-width: 720px)': { gridArea: 'sigil', width: 'clamp(148px, 52vw, 200px)' },
  },

  sigilSettled: {
    opacity: 0.7,
    filter: 'grayscale(0.55) brightness(0.8)',
  },

  sigilMatched: {
    filter: 'brightness(1.18)',
  },

  ring: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: '50%',
    pointerEvents: 'none',
  },

  ringPulse: {
    border: '1px solid rgba(159, 146, 255, 0.35)',
    boxShadow: 'inset 0 0 34px rgba(122, 96, 255, 0.18)',
  },

  ringPulseRun: {
    animationName: pulse,
    animationDuration: '3.4s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  /* A comet arc sweeping the ring: the visible "still searching" signal. */
  ringSweep: {
    top: '6%',
    right: '6%',
    bottom: '6%',
    left: '6%',
    background:
      'conic-gradient(from 0deg, transparent 0 62%, rgba(98, 211, 255, 0.75) 88%, rgba(255, 215, 154, 0.9) 96%, transparent 100%)',
    WebkitMask:
      'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))',
    mask: 'radial-gradient(farthest-side, transparent calc(100% - 3px), #000 calc(100% - 2px))',
    filter: 'drop-shadow(0 0 10px rgba(98, 211, 255, 0.45))',
  },

  ringSweepRun: {
    animationName: spin,
    animationDuration: '4.6s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  /* A poll that failed is still a live search, just a slower one. */
  ringSweepRetry: {
    opacity: 0.45,
  },

  ringInner: {
    top: '13%',
    right: '13%',
    bottom: '13%',
    left: '13%',
    border: '1px dashed rgba(170, 156, 255, 0.4)',
  },

  orbit: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: '50%',
  },

  orbitRun: {
    animationName: spin,
    animationDuration: '17s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  /* Orbiting motes: each wrapper spans the ring so its own rotation moves the
     dot around the centre instead of around itself. */
  mote: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: '50%',
    '::before': {
      content: '""',
      position: 'absolute',
      top: '1%',
      left: '50%',
      width: 9,
      height: 9,
      marginLeft: -4.5,
      borderRadius: '50%',
      background: 'radial-gradient(circle, #fff 0 18%, #a99cff 46%, rgba(106, 88, 255, 0) 72%)',
    },
  },

  moteRun: {
    '::before': {
      animationName: twinkle,
      animationDuration: '2.2s',
      animationTimingFunction: 'ease-in-out',
      animationIterationCount: 'infinite',
      '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
    },
  },

  moteB: { transform: 'rotate(128deg)' },
  moteC: { transform: 'rotate(246deg)' },

  /* A soft glow behind the crest; opacity-only so centring survives the pulse. */
  spark: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: '112%',
    height: '112%',
    transform: 'translate(-50%, -50%)',
    opacity: 0.34,
    pointerEvents: 'none',
  },

  sparkRun: {
    animationName: glow,
    animationDuration: '3.4s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  core: {
    position: 'relative',
    width: '44%',
    borderRadius: '50%',
    filter: 'drop-shadow(0 0 18px rgba(159, 146, 255, 0.55))',
  },

  coreRun: {
    animationName: breathe,
    animationDuration: '3.4s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  /* ------------------------------------------------------------ brief --- */

  brief: {
    marginBottom: 0,
  },

  state: {
    margin: '0 0 14px',
    fontSize: 'clamp(1.02rem, 1.7vw, 1.2rem)',
    color: 'var(--ink)',
  },

  stateSettled: {
    color: 'var(--ink-dim)',
  },

  error: {
    margin: '0 0 14px',
  },

  /** The shared notice is neutral; a failed poll is the one tone this screen shows. */
  noticeError: {
    borderColor: 'rgba(255, 107, 125, 0.45)',
    background: 'rgba(56, 18, 28, 0.62)',
    color: '#ffd8de',
  },

  facts: {
    margin: '0 0 14px',
  },

  difficultyHint: {
    margin: '6px 0 0',
  },

  elapsed: {
    fontSize: 'clamp(1.7rem, 3.6vw, 2.3rem)',
    lineHeight: 1.15,
    color: 'var(--gold)',
    whiteSpace: 'nowrap',
    textShadow: '0 0 26px rgba(255, 215, 154, 0.26)',
    '@media (max-width: 420px)': { fontSize: '1.55rem' },
  },

  home: {
    textDecoration: 'none',
  },

  hint: {
    margin: '12px 0 0',
  },

  motion: {
    '@media (prefers-reduced-motion: reduce)': { display: 'none' },
  },

  /* A settled screen is visibly not searching. */
  motionSettled: {
    display: 'none',
  },

  /**
   * Freezes every running animation where it stands, including the two animated
   * pseudo-elements. Composed last, so it needs no `!important`.
   */
  paused: {
    animationPlayState: 'paused',
    '::before': { animationPlayState: 'paused' },
    '::after': { animationPlayState: 'paused' },
  },
});
