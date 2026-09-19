/**
 * 已废弃的 `queue.css` 的 StyleX 迁移实现。
 *
 * 下方所有数值均源自原样式表：存放在 CSS 变量中的主题部分仍通过变量名引用（`var(--ink)` 等），
 * 原文件中用作选择器钩子的复合选择器（`.duelist--self .duelist__art`, `[data-state="waiting"] …`）
 * 则直接在 JSX 调用处根据对应的响应式状态解构应用。
 *
 * 系统的减少动态效果偏好会禁用装饰性动画。
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
  /* ------------------------------------------------------------ 匹配舞台 --- */

  stage: {
    position: 'relative',
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto minmax(0, 1fr)',
    alignItems: 'center',
    justifyItems: 'center',
    rowGap: 'clamp(10px, 2.2vw, 28px)',
    columnGap: 'clamp(10px, 2.2vw, 28px)',
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
      gridTemplateColumns: 'minmax(0, 1fr) 64px minmax(0, 1fr)',
      gridTemplateAreas: '"self sigil rival"',
      columnGap: 10,
    },
    '@media (max-width: 420px)': { padding: '26px 22px' },
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

  /* 扫掠光泽仅在搜索进行中时激活展示。 */
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

  /* --------------------------------------------------------- 对决双方 --- */

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

  /* 匹配结算后的界面，视觉上明确退出搜索状态。 */
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
    '@media (max-width: 420px)': { width: 'min(100%,88px)' },
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

  /* 尚未揭晓的对手：使用扫描面纱呈现，绝不使用虚构头像。 */
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
  },

  selfTag: {
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

  nameUnknown: {
    letterSpacing: '.3em',
    color: 'var(--ink-faint)',
  },

  note: {
    fontSize: '.8rem',
    color: 'var(--ink-faint)',
    '@media (max-width: 420px)': { fontSize: '.75rem' },
  },

  /* ------------------------------------------------------------ 魔法印记 --- */

  sigil: {
    position: 'relative',
    zIndex: 1,
    display: 'grid',
    placeItems: 'center',
    width: 'clamp(168px, 22vw, 244px)',
    aspectRatio: 1,
    '@media (max-width: 720px)': { gridArea: 'sigil', width: 64 },
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

  /* 掠过光环的彗星光弧：视觉上呈现“搜索中”的动态信号。 */
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

  /* 轮询偶发失败时仍属于进行中的搜索，仅速度降频。 */
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

  /* ------------------------------------------------------------ 简报面板 --- */

  workspace: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignItems: 'start',
    gap: 18,
  },

  brief: {
    marginBottom: 0,
  },

  /** 标题与 1v1 标签在视觉上融为一个单元。 */
  titleGroup: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    minWidth: 0,
    flexWrap: 'wrap',
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

  /** 公共提示框默认中性；轮询失败是本屏幕唯一展示的有色调警告。 */
  noticeError: {
    backgroundImage:
      'linear-gradient(rgba(88, 20, 34, 0.72), rgba(88, 20, 34, 0.72)), var(--surface-stone)',
    backgroundSize: 'auto, 256px 256px',
    backgroundRepeat: 'no-repeat, repeat',
    color: '#ffd8de',
  },

  facts: {
    margin: '0 0 14px',
    gap: 10,
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  },
  fact: { minWidth: 0, '@media (max-width: 640px)': { padding: '14px 10px' } },

  /** 实时在线人数脚注：加载中、陈旧或刷新失败。 */
  activityNote: {
    margin: '0 0 14px',
    fontSize: '.82rem',
    color: 'var(--ink-faint)',
  },

  activityNoteError: {
    color: '#ffd8de',
  },

  elapsed: {
    color: 'var(--gold)',
  },

  home: {
    textDecoration: 'none',
  },

  hint: {
    margin: '12px 0 0',
  },
});
