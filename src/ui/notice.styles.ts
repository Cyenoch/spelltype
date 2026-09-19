import * as stylex from '@stylexjs/stylex';

/**
 * 公共提示框默认样式为中性色调；需要特定语气色调或内嵌操作按钮行的视图，
 * 可以在 `ui.notice` 的基础上叠加组合这些样式。
 */
export const noticeStyles = stylex.create({
  warn: {
    borderImageSource: 'var(--frame-control)',
    backgroundImage: 'linear-gradient(#7c501b22,#7c501b22),var(--surface-stone)',
    backgroundSize: 'auto,256px 256px',
    backgroundRepeat: 'no-repeat,repeat',
    color: '#ffe4b8',
  },
  /** 自带操作按钮的提示框，使按钮与上方文案保持适当间距。 */
  actions: {
    marginTop: 8,
  },
});
