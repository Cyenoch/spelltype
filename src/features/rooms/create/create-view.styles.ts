import * as stylex from '@stylexjs/stylex';

/** 自定义房间表单的局部样式；共享控件、面板和提示框均来自 `ui`。 */
export const styles = stylex.create({
  /** 预设主题栏作为其下方主题配置块的一部分：采用低调的石质搁架样式
   *  将选项标签分组，使其呈现为统一的控制组。 */
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

  /** 提交按钮是主要操作；与上方的依赖输入字段保持适度间距。 */
  submitRow: {
    marginTop: 16,
  },

  /** 共享的 `steps` 样式针对列表本身，而非其列表项。 */
  step: {
    marginBottom: '.4em',
  },
});
