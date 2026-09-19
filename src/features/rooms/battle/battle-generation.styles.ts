import * as stylex from '@stylexjs/stylex';

/**
 * 咒文生成专用场景（权威 `generating` 阶段）的样式：
 * 旋转符文环中悬浮的一本魔导书，使战斗前的停顿读起来像一场仪式，
 * 而绝不是卡死的空白输入界面。
 *
 * 动效遵循排队界面的词汇表，采用组合而非覆盖的方式：
 * `*Run` 类施加动画，减弱动效偏好（由 motion.ts 镜像到 `<html>` 上）
 * 会彻底移除动画名称，使静态场景保持清晰，
 * 而共享的 `paused` 类则把正在运行的一切冻结在原地。
 * 每个动画只改动 `transform` 或 `opacity`。
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
  /* ------------------------------------------------------------- 场景 --- */

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
    padding: 'clamp(26px, 3.4vw, 44px) clamp(18px, 2.6vw, 34px)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: 0,
    backgroundImage:
      'radial-gradient(120% 90% at 50% -20%, rgba(122, 96, 255, 0.22), transparent 60%), linear-gradient(180deg, rgba(24, 18, 52, 0.66), rgba(9, 7, 22, 0.92)), var(--surface-leather)',
    backgroundSize: 'auto, auto, 256px 256px',
    backgroundRepeat: 'no-repeat, no-repeat, repeat',
    boxShadow: 'var(--shadow)',
    '::before': {
      content: '""',
      position: 'absolute',
      inset: 0,
      zIndex: 2,
      pointerEvents: 'none',
      borderWidth: 1,
      borderStyle: 'solid',
      borderColor: 'transparent',
      borderImageSource: 'var(--frame-panel)',
      borderImageSlice: 48,
      borderImageWidth: '26px',
      borderImageRepeat: 'stretch',
    },
  },

  /* 满幅场景在画框前景之下渐隐融入材质。 */
  backdrop: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    zIndex: 0,
    objectFit: 'cover',
    opacity: 0.16,
    maskImage: 'radial-gradient(ellipse at 50% 40%,#000 30%,transparent 90%)',
    pointerEvents: 'none',
  },

  /* 上升的浮尘：纯装饰，靠逐粒定位铺开。 */
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
    backgroundImage: 'radial-gradient(circle, #fff 0 20%, #a99cff 48%, rgba(106, 88, 255, 0) 74%)',
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
    paddingBottom: 22,
    backgroundImage: 'var(--ornament-divider)',
    backgroundSize: '240px 18px',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center bottom',
    '@media (max-width: 420px)': { fontSize: '1.42rem' },
  },

  /* 唯一一句实时文案：谁已准备、本房间在等待什么
     （一本共享的预设咒文书、它的一次刷新，或一次按对局生成），
     以及随后的倒计时 —— 全部都是权威文案。 */
  state: {
    margin: 0,
    maxWidth: 'min(560px, 100%)',
    color: 'var(--ink-dim)',
    fontSize: 'clamp(0.92rem, 1.5vw, 1.02rem)',
    lineHeight: 1.75,
    overflowWrap: 'anywhere',
  },

  /* ------------------------------------------------------------ 舞台 --- */

  stage: {
    position: 'relative',
    display: 'grid',
    placeItems: 'center',
    width: 'clamp(236px, 30vw, 330px)',
    aspectRatio: 1,
    marginTop: 2,
    '@media (max-width: 720px)': { width: 'clamp(212px, 60vw, 280px)' },
  },

  /* 书后的柔光；只改透明度，因此居中线在脉动中始终成立。 */
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
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'rgba(159, 146, 255, 0.32)',
    boxShadow: 'inset 0 0 34px rgba(122, 96, 255, 0.16)',
  },

  ringPulseRun: {
    animationName: pulse,
    animationDuration: '3.4s',
    animationTimingFunction: 'ease-in-out',
    animationIterationCount: 'infinite',
    '@media (prefers-reduced-motion: reduce)': { animationName: 'none' },
  },

  /* 书页正在被书写时，环绕书本涌动的能量弧。 */
  ringSweep: {
    top: '4%',
    right: '4%',
    bottom: '4%',
    left: '4%',
    backgroundImage:
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
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(170, 156, 255, 0.38)',
    opacity: 0.8,
  },

  /* 环绕飞行的元素字形：外层容器横跨整环，因此其自身的旋转会把符印
     沿中心移动；每个字形反向旋转，使美术在轨道的任何位置都保持正立。 */
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

  /* 反向轨道上的两点余烬；因为是圆点，无需校正正立方向。 */
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
      backgroundImage:
        'radial-gradient(circle, #fff 0 18%, #ffd9a2 46%, rgba(255, 179, 102, 0) 72%)',
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

  /* ------------------------------------------------------------- 书本 --- */

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
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'rgba(199, 178, 255, 0.4)',
    borderRadius: '10px 14px 14px 10px',
    backgroundImage:
      'linear-gradient(150deg, rgba(66, 50, 108, 0.95), rgba(39, 29, 74, 0.95) 52%, rgba(25, 18, 48, 0.95)), var(--surface-leather)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
    boxShadow:
      '0 24px 48px rgba(3, 2, 12, 0.6), inset 0 1px 0 rgba(255, 236, 200, 0.18), inset 0 0 30px rgba(122, 96, 255, 0.18)',
    /* 沿装订边的高光。 */
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

  /* 一道缓慢扫过封面的光：书页显然正在被书写。 */
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

  /* 从书口边缘探出的书页块，位于封面之后。 */
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

  /* 贴地阴影；它随悬浮一同呼吸，使书本始终像扎根在地面上。 */
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

  /* ------------------------------------------------------------- 文案 --- */

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

  /* 当系统偏好已经移除了全部动效时，暂停开关就没有意义，
     因此它会像排队界面的开关一样让位隐藏。 */
  motionToggle: {
    '@media (prefers-reduced-motion: reduce)': { display: 'none' },
  },

  /**
   * 把所有正在运行的动画冻结在原地，包括带动画效果的伪元素。
   * 最后组合，因此无需 `!important`。
   */
  paused: {
    animationPlayState: 'paused',
    '::before': { animationPlayState: 'paused' },
    '::after': { animationPlayState: 'paused' },
  },
});
