import * as stylex from '@stylexjs/stylex';

/**
 * Local styles for the homepage entrance and the standalone guide.
 * Shared controls (buttons, panels, notices, fields, chips, steps, keycaps)
 * come from `ui`; everything here is specific to these two views.
 */
export const styles = stylex.create({
  /* ------------------------------------------------------------- homepage -- */

  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 16,
  },

  hero: {
    position: 'relative',
    overflow: 'hidden',
    border: '1px solid var(--line-strong)',
    borderRadius: 'calc(var(--radius) + 8px)',
    background: 'linear-gradient(160deg, rgba(48, 38, 96, 0.9), rgba(11, 9, 24, 0.94))',
    boxShadow: 'var(--shadow)',
    /** Scrim, so the title and the buttons never fight the art behind them. */
    '::after': {
      content: '""',
      position: 'absolute',
      inset: 0,
      background:
        'radial-gradient(120% 90% at 14% 0%, rgba(122, 104, 255, 0.3), transparent 62%), linear-gradient(180deg, rgba(7, 6, 15, 0.5) 0%, rgba(7, 6, 15, 0.84) 52%, rgba(7, 6, 15, 0.96) 100%)',
    },
  },
  /** Decorative key art: the same generated arena art the battle stage uses. */
  heroArt: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    objectPosition: 'center 34%',
    opacity: 0.55,
  },
  heroLayout: {
    position: 'relative',
    zIndex: 1,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 0.95fr)',
    gap: 16,
    alignItems: 'stretch',
    padding: 'clamp(14px, 2.2vw, 24px) clamp(16px, 3vw, 34px)',
    '@media (max-width: 1080px)': {
      gridTemplateColumns: 'minmax(0, 1fr)',
    },
  },
  heroMain: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
  },
  crest: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  crestImg: {
    flex: 'none',
    borderRadius: 12,
    border: '1px solid rgba(255, 215, 154, 0.34)',
    boxShadow: '0 0 20px rgba(150, 136, 255, 0.26)',
  },
  heroEyebrow: {
    fontSize: '.76rem',
    letterSpacing: '.22em',
    textTransform: 'uppercase',
    color: 'var(--gold)',
  },
  sigils: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginLeft: 'auto',
    opacity: 0.85,
  },
  sigilImg: {
    flex: 'none',
    filter: 'drop-shadow(0 0 9px rgba(150, 136, 255, 0.45))',
  },
  heroTitle: {
    margin: '6px 0 4px',
    fontSize: 'clamp(1.95rem, 4.4vw, 2.85rem)',
    lineHeight: 1.06,
    letterSpacing: '.12em',
    color: 'var(--ink)',
    textShadow: '0 0 34px rgba(150, 136, 255, 0.35)',
    '@supports (background-clip: text) or (-webkit-background-clip: text)': {
      background: 'linear-gradient(110deg, #fff 4%, var(--gold) 44%, var(--arcane) 100%)',
      backgroundClip: 'text',
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
    },
  },
  heroLead: {
    margin: '0 0 12px',
    fontSize: 'clamp(0.96rem, 1.3vw, 1.06rem)',
    letterSpacing: '.04em',
    color: 'var(--ink-dim)',
  },
  facts: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))',
    gap: 1,
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--line)',
    overflow: 'hidden',
    '@media (max-width: 620px)': {
      gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    },
  },
  /** The homepage spreads the facts from the copy above; the guide head owns its spacing. */
  factsSpaced: {
    margin: '0 0 14px',
  },
  fact: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
    padding: '8px 12px',
    background: 'rgba(9, 7, 20, 0.72)',
  },
  factValue: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'clamp(1.15rem, 2vw, 1.5rem)',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--gold)',
  },
  factLabel: {
    fontSize: '.74rem',
    letterSpacing: '.08em',
    color: 'var(--ink-faint)',
  },
  /** Notices inside the hero keep the card's rhythm instead of the shared bottom margin. */
  heroNotice: {
    marginTop: 0,
    marginBottom: 12,
  },
  h2Size: {
    fontSize: 'clamp(1.35rem, 2.6vw, 1.85rem)',
  },

  entries: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1.1fr) minmax(0, 0.9fr)',
    gap: 12,
    marginTop: 'auto',
    '@media (max-width: 860px)': {
      gridTemplateColumns: 'minmax(0, 1fr)',
    },
  },
  entry: {
    display: 'flex',
    flexDirection: 'column',
    gap: 7,
    minWidth: 0,
    padding: 12,
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius)',
    background: 'linear-gradient(180deg, rgba(28, 22, 58, 0.74), rgba(11, 9, 24, 0.8))',
  },
  entryQuick: {
    border: '1px solid rgba(170, 156, 255, 0.5)',
    boxShadow: '0 0 0 1px rgba(150, 136, 255, 0.12), 0 18px 40px rgba(56, 38, 132, 0.3)',
  },
  entryHead: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    flexWrap: 'wrap',
  },
  entryTitle: {
    margin: 0,
    fontSize: '1.1rem',
    letterSpacing: '.06em',
    color: 'var(--ink)',
  },
  entryTitleRoom: {
    fontSize: 'clamp(1.35rem, 2.6vw, 1.85rem)',
  },
  entryTag: {
    flex: 'none',
    padding: '2px 9px',
    border: '1px solid var(--line-strong)',
    borderRadius: 999,
    fontSize: '.72rem',
    letterSpacing: '.1em',
    color: 'var(--gold)',
  },
  entryNote: {
    margin: 0,
    fontSize: '.86rem',
    color: 'var(--ink-dim)',
  },
  entrySeats: {
    display: 'flex',
    gap: 6,
    marginTop: 'auto',
  },
  seatImg: {
    flex: 'none',
    width: 28,
    height: 28,
    border: '1px solid var(--line-strong)',
    borderRadius: 9,
    objectFit: 'cover',
    opacity: 0.85,
  },
  /** The two CTAs share one baseline, whatever each card's copy does above them. */
  entryButton: {
    width: '100%',
    marginTop: 'auto',
    padding: '12px 18px',
    fontSize: 'clamp(1rem, 1.6vw, 1.12rem)',
    letterSpacing: '.04em',
  },
  /** The room card's own art fills the space the quick card spends on the picker. */
  entryButtonRoom: {
    marginTop: 0,
  },

  /* ------------------------------------------------------------ player card -- */

  aside: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    minWidth: 0,
    padding: 16,
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius)',
    background: 'rgba(10, 8, 22, 0.64)',
    boxShadow: '0 14px 34px rgba(4, 2, 14, 0.45)',
    backdropFilter: 'blur(8px)',
  },
  pc: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    minWidth: 0,
  },
  pcGuest: {
    gap: 10,
  },
  pcHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
  },
  pcAvatar: {
    flex: 'none',
    width: 56,
    height: 56,
    border: '1px solid var(--line-strong)',
    borderRadius: 14,
    objectFit: 'cover',
    background: 'rgba(12, 10, 26, 0.6)',
    boxShadow: '0 0 18px rgba(150, 136, 255, 0.18)',
  },
  pcAvatarGuest: {
    filter: 'grayscale(0.7)',
    opacity: 0.85,
  },
  pcId: {
    minWidth: 0,
  },
  pcName: {
    fontFamily: 'var(--font-display)',
    fontSize: 'clamp(1.1rem, 1.9vw, 1.35rem)',
    letterSpacing: '.04em',
    color: 'var(--ink)',
    overflowWrap: 'anywhere',
  },
  pcMeta: {
    fontSize: '.8rem',
    overflowWrap: 'anywhere',
  },
  pcSub: {
    color: 'var(--ink-faint)',
  },
  pcStats: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 1,
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm)',
    background: 'var(--line)',
    overflow: 'hidden',
  },
  pcStat: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minWidth: 0,
    padding: '8px 10px',
    background: 'rgba(9, 7, 20, 0.72)',
    '@media (max-width: 620px)': {
      padding: '8px 9px',
    },
  },
  pcStatLabel: {
    fontSize: '.72rem',
    letterSpacing: '.06em',
    color: 'var(--ink-faint)',
  },
  pcStatValue: {
    fontFamily: 'var(--font-mono)',
    fontSize: '1.2rem',
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--gold)',
    '@media (max-width: 620px)': {
      fontSize: '1.1rem',
    },
  },
  pcStatRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 4,
    minWidth: 0,
    flexWrap: 'wrap',
  },
  pcStatUnit: {
    fontSize: '.72rem',
    color: 'var(--ink-faint)',
    whiteSpace: 'nowrap',
  },
  pcRecent: {
    margin: 0,
    color: 'var(--ink-dim)',
  },
  pcNote: {
    margin: 0,
    color: 'var(--ink-faint)',
  },
  pcNoteError: {
    color: '#ffd8de',
  },
  pcRow: {
    marginTop: 'auto',
  },
  pcButton: {
    flex: '1 1 120px',
  },

  /* ------------------------------------------------- tutorial + guide link -- */

  tutorial: {
    margin: 0,
    padding: 'clamp(12px, 1.8vw, 18px)',
  },
  tutorialHead: {
    marginBottom: 8,
  },
  tutorialSteps: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 10,
    margin: 0,
    padding: 0,
    listStyle: 'none',
    counterReset: 'step',
    color: 'var(--ink-dim)',
    '@media (max-width: 860px)': {
      gridTemplateColumns: 'minmax(0, 1fr)',
    },
  },
  tutorialStep: {
    position: 'relative',
    margin: 0,
    padding: '26px 12px 9px',
    border: '1px solid var(--line)',
    borderRadius: 'var(--radius-sm)',
    background: 'rgba(12, 10, 26, 0.5)',
    fontSize: '.86rem',
    lineHeight: 1.6,
    '::before': {
      counterIncrement: 'step',
      content: 'counter(step)',
      position: 'absolute',
      top: 8,
      left: 12,
      width: 18,
      height: 18,
      border: '1px solid var(--line-strong)',
      borderRadius: '50%',
      color: 'var(--gold)',
      fontFamily: 'var(--font-mono)',
      fontSize: '.7rem',
      lineHeight: '16px',
      textAlign: 'center',
    },
  },
  guideLink: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 10,
    padding: '9px 14px',
    border: '1px dashed var(--line-strong)',
    borderRadius: 'var(--radius-sm)',
    background: 'rgba(20, 16, 44, 0.6)',
    color: 'var(--ink)',
    fontWeight: 600,
    textDecoration: 'none',
    transition: 'border-color 0.18s ease, background 0.18s ease, color 0.18s ease',
    ':hover': {
      borderColor: 'var(--gold)',
      background: 'rgba(40, 30, 76, 0.72)',
      color: 'var(--gold)',
    },
  },
  guideArrow: {
    flex: 'none',
    fontFamily: 'var(--font-mono)',
    color: 'var(--gold)',
  },

  /* ------------------------------------------------------------ guide page -- */

  guide: {
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
  },
  guideHead: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 18,
    padding: 'clamp(20px, 3.4vw, 38px) clamp(18px, 3.2vw, 40px)',
    border: '1px solid var(--line-strong)',
    borderRadius: 'calc(var(--radius) + 6px)',
    background:
      'radial-gradient(120% 90% at 10% 0%, rgba(122, 104, 255, 0.26), transparent 60%), linear-gradient(150deg, rgba(48, 38, 96, 0.86), rgba(11, 9, 24, 0.94))',
    boxShadow: 'var(--shadow)',
  },
  guideHeadMain: {
    flex: '1 1 380px',
    minWidth: 0,
  },
  guideTitle: {
    margin: '12px 0 8px',
    fontSize: 'clamp(1.8rem, 4.2vw, 2.7rem)',
    letterSpacing: '.1em',
    color: 'var(--ink)',
  },
  guideLead: {
    maxWidth: '44rem',
    margin: '0 0 16px',
    color: 'var(--ink-dim)',
  },
  guideBack: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    flex: 'none',
    padding: '9px 16px',
    border: '1px solid var(--line-strong)',
    borderRadius: 999,
    background: 'rgba(12, 10, 26, 0.66)',
    color: 'var(--ink)',
    fontSize: '.88rem',
    fontWeight: 600,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    transition: 'border-color 0.18s ease, color 0.18s ease, background 0.18s ease',
    ':hover': {
      borderColor: 'var(--gold)',
      background: 'rgba(36, 27, 70, 0.75)',
      color: 'var(--gold)',
    },
  },
  backArrow: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--gold)',
  },
  guideGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: 16,
  },
  guideSection: {
    margin: 0,
  },
  guideSectionTitle: {
    margin: '0 0 10px',
    fontSize: '1.1rem',
    letterSpacing: '.05em',
  },
  guideStep: {
    marginBottom: '.5em',
  },
  guideFoot: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 14,
  },
  guideFootImg: {
    opacity: 0.7,
  },
});
