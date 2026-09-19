/**
 * 准备大厅沿用了匹配页面的视觉血统：相同的影院级竞技场舞台、
 * 簇拥中央印记的双方圆形决斗者头像，以及相同的组合式动画规范——
 * 状态类名负责应用对应动画，系统的减少动态效果偏好则完全移除动画名称。
 * 匹配界面是在扫描面纱后寻找对手，而大厅则展示已就位的对手、
 * 他们的准备状态，以及正在准备中的共享咒文书。
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
  /* ------------------------------------------------------------ 舞台 --- */

  stage: {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
    alignItems: 'center',
    justifyItems: 'center',
    rowGap: 'clamp(10px, 2.2vw, 24px)',
    columnGap: 'clamp(10px, 2.4vw, 30px)',
    padding: 'clamp(30px, 3.2vw, 44px) clamp(28px, 2.6vw, 38px)',
    marginBottom: 18,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-panel)',
    borderImageSlice: 48,
    borderImageWidth: '26px',
    borderImageRepeat: 'stretch',
    borderRadius: 0,
    backgroundImage:
      'radial-gradient(120% 130% at 50% -30%, rgba(122, 96, 255, 0.24), transparent 62%), linear-gradient(180deg, rgba(24, 18, 52, 0.72), rgba(9, 7, 22, 0.94)), var(--spelltype-arena-image)',
    backgroundPosition: '0% 0%, 0% 0%, center',
    backgroundSize: 'auto, auto, cover',
    boxShadow: 'var(--shadow), var(--glow)',
    overflow: 'hidden',
    isolation: 'isolate',
    '@media (max-width: 720px)': {
      gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
      gridTemplateAreas: '"self rival" "center center"',
      rowGap: 18,
    },
    '@media (max-width: 420px)': { padding: '26px 22px' },
  },

  stagePrivate: {
    '@media (max-width: 720px)': { gridTemplateAreas: '"self center" "rival rival"' },
  },

  /* 隐约的竞技场光环，使舞台呈现为一个具体场景而非扁平卡片。 */
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

  /* 房间进行工作时的流动光泽：等待预留对手进房，或正在准备共享咒文书。 */
  stageLive: {
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

  /* ------------------------------------------------------------- 阵营侧 --- */

  side: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 14,
    minWidth: 0,
  },

  sideSelf: {
    '@media (max-width: 720px)': { gridArea: 'self' },
  },

  sideRival: {
    '@media (max-width: 720px)': { gridArea: 'rival' },
  },

  sideParty: {
    '@media (max-width: 720px)': {
      width: '100%',
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-evenly',
      gap: 10,
    },
  },

  /* ------------------------------------------------------------ 中央徽记 --- */

  center: {
    position: 'relative',
    zIndex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    '@media (max-width: 720px)': { gridArea: 'center' },
  },

  emblem: {
    position: 'relative',
    display: 'grid',
    placeItems: 'center',
    width: 'clamp(148px, 16vw, 200px)',
    aspectRatio: 1,
    '@media (max-width: 420px)': { width: 'clamp(122px, 44vw, 160px)' },
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

  /* 彗星光弧：视觉上呈现“正在撰写咒文书”的动态信号。 */
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

  /* 环绕微粒：每个包裹层跨越整个圆环，使其自身旋转带动微粒围绕中心公转，
     而非仅自身自转。 */
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

  /* 徽记背后的柔和光晕；仅调节透明度，避免呼吸脉冲影响居中定位。 */
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

  emblemNote: {
    padding: '3px 14px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-control)',
    borderImageSlice: 48,
    borderImageWidth: '10px',
    borderImageRepeat: 'stretch',
    borderRadius: 0,
    backgroundColor: '#161127',
    backgroundImage: 'var(--surface-stone)',
    backgroundSize: '256px 256px',
    backgroundRepeat: 'repeat',
    fontFamily: 'var(--font-display)',
    fontSize: '.8rem',
    letterSpacing: '.32em',
    textIndent: '.32em',
    color: 'var(--ink-dim)',
    whiteSpace: 'nowrap',
  },

  emblemNoteVS: {
    color: 'var(--gold)',
    backgroundImage:
      'linear-gradient(rgba(255, 215, 154, 0.1), rgba(255, 215, 154, 0.1)), var(--surface-stone)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
  },

  /* ------------------------------------------------------------- 席位卡片 --- */

  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
    maxWidth: '100%',
    textAlign: 'center',
  },

  /* 多出的对手与空闲邀请席位横向排布成一行，确保 3 个席位也不会超出舞台尺寸。
     低调的石质内凹底座确保文字在竞技场背景画上清晰可读，同时避免重复框住大型决斗头像。 */
  cardCompact: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    textAlign: 'left',
    padding: '10px 14px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-inset)',
    borderImageSlice: 48,
    borderImageWidth: '12px',
    borderImageRepeat: 'stretch',
    borderRadius: 0,
    backgroundColor: '#141126',
    backgroundImage:
      'linear-gradient(180deg, rgba(24, 18, 52, 0.42), rgba(10, 8, 22, 0.52)), var(--surface-stone)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
    '@media (max-width: 720px)': { flexDirection: 'column', textAlign: 'center', flex: '1 1 0' },
  },

  cardOffline: {
    opacity: 0.6,
  },

  art: {
    position: 'relative',
    display: 'grid',
    placeItems: 'center',
    flex: 'none',
    width: 'clamp(108px, 14vw, 148px)',
    aspectRatio: 1,
    border: '1px solid var(--line-strong)',
    borderRadius: '50%',
    background:
      'radial-gradient(72% 72% at 50% 28%, rgba(159, 146, 255, 0.26), rgba(10, 8, 24, 0.92))',
    '@media (max-width: 420px)': { width: 'clamp(84px, 26vw, 108px)' },
  },

  artCompact: {
    width: 'clamp(62px, 9vw, 84px)',
    '@media (max-width: 720px)': { width: 56 },
    '@media (max-width: 420px)': { width: 56 },
  },

  artSelf: {
    borderColor: 'rgba(255, 215, 154, 0.55)',
    boxShadow: '0 0 34px rgba(255, 215, 154, 0.18), inset 0 0 30px rgba(255, 215, 154, 0.12)',
  },

  /* 圆环颜色专用于表达准备状态；身份标识由标签承载。
     样式最后组合，优先级高于自身高亮色。 */
  artReady: {
    borderColor: 'rgba(100, 230, 176, 0.6)',
    boxShadow: '0 0 30px rgba(100, 230, 176, 0.26), inset 0 0 24px rgba(100, 230, 176, 0.14)',
  },

  artEmpty: {
    borderStyle: 'dashed',
    borderColor: 'rgba(150, 136, 255, 0.34)',
    background:
      'radial-gradient(72% 72% at 50% 28%, rgba(92, 82, 142, 0.24), rgba(8, 7, 18, 0.95))',
    overflow: 'hidden',
  },

  avatar: {
    width: '100%',
    height: '100%',
    borderRadius: '50%',
    objectFit: 'cover',
  },

  /* 尚未进房的预留对手：显示带有遮罩的印记，绝不使用虚构头像。 */
  crestVeiled: {
    width: '58%',
    height: '58%',
    borderRadius: 14,
    objectFit: 'contain',
    opacity: 0.8,
    filter: 'blur(2.5px) saturate(0.6) brightness(0.85)',
  },

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

  unknownCompact: {
    fontSize: 'clamp(1.3rem, 3vw, 1.7rem)',
  },

  cardBody: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4,
    minWidth: 0,
    maxWidth: '100%',
  },

  cardBodyCompact: {
    alignItems: 'flex-start',
    gap: 3,
    '@media (max-width: 720px)': { alignItems: 'center' },
  },

  tag: {
    padding: '3px 10px',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-control)',
    borderImageSlice: 48,
    borderImageWidth: '10px',
    borderImageRepeat: 'stretch',
    borderRadius: 0,
    backgroundColor: '#181331',
    backgroundImage: 'var(--surface-stone)',
    backgroundSize: '256px 256px',
    backgroundRepeat: 'repeat',
    fontSize: '.72rem',
    letterSpacing: '.18em',
    color: 'var(--ink-faint)',
    whiteSpace: 'nowrap',
  },

  tagSelf: {
    color: 'var(--gold)',
    backgroundImage:
      'linear-gradient(rgba(255, 215, 154, 0.1), rgba(255, 215, 154, 0.1)), var(--surface-stone)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
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

  nameCompact: {
    fontSize: '.95rem',
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

  badges: { display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 4 },

  badge: {
    fontSize: '.72rem',
    paddingTop: 3,
    paddingRight: 9,
    paddingBottom: 3,
    paddingLeft: 9,
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-control)',
    borderImageSlice: 48,
    borderImageWidth: '10px',
    borderImageRepeat: 'stretch',
    backgroundColor: '#151221',
    backgroundImage: 'var(--surface-stone)',
    backgroundSize: '256px 256px',
    backgroundRepeat: 'repeat',
    color: 'var(--ink-dim)',
  },
  badgeHost: {
    color: 'var(--gold)',
    backgroundImage:
      'linear-gradient(rgba(255, 215, 154, 0.12), rgba(255, 215, 154, 0.12)), var(--surface-stone)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
  },
  badgeReady: {
    color: 'var(--good)',
    backgroundImage:
      'linear-gradient(rgba(100, 230, 176, 0.1), rgba(100, 230, 176, 0.1)), var(--surface-stone)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
  },
  badgeOffline: {
    color: 'var(--danger)',
    backgroundImage:
      'linear-gradient(rgba(255, 107, 125, 0.1), rgba(255, 107, 125, 0.1)), var(--surface-stone)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
  },
  /** 刻意保持低调：非真人对手明确标注一次即可，绝不伪装成人类对手。 */
  badgeSynthetic: {
    color: 'var(--ink-faint)',
  },

  /* ------------------------------------------------------------- 房间简报 --- */

  brief: {
    marginBottom: 0,
  },

  state: {
    margin: '0 0 12px',
    fontSize: 'clamp(1.02rem, 1.7vw, 1.2rem)',
    color: 'var(--ink)',
  },

  reservation: {
    margin: '0 0 12px',
  },

  generating: {
    margin: '0 0 12px',
  },

  /* 房间属性信息保持单行低调展示：房间 ID 放置于此作为次要信息，
     而非占据整个显眼的标题行。 */
  facts: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px 26px',
    margin: '4px 0 16px',
  },

  fact: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    minWidth: 0,
    maxWidth: '100%',
  },

  factLabel: {
    flex: 'none',
    fontSize: '.76rem',
    letterSpacing: '.14em',
    color: 'var(--ink-faint)',
  },

  factValue: {
    margin: 0,
    fontSize: '.88rem',
    fontWeight: 600,
    color: 'var(--ink)',
    overflowWrap: 'anywhere',
  },

  roomId: {
    fontFamily: 'var(--font-mono)',
    fontWeight: 500,
    color: 'var(--ink-dim)',
    letterSpacing: '.04em',
    userSelect: 'all',
  },

  /** 属性信息内的邀请行：先展示房间号，紧接着是复制操作按钮。 */
  roomIdCell: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    margin: 0,
    minWidth: 0,
    maxWidth: '100%',
  },

  copyCode: {
    flex: 'none',
  },

  actions: { marginTop: 2, marginBottom: 0 },
});
