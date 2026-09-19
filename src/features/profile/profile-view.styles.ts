import * as stylex from '@stylexjs/stylex';

/**
 * 账户概览页面的局部样式。面板、图块、表格和按钮均来自 `ui`；
 * 此处所有样式均为历史战绩面板自身的控件专属。
 */
export const styles = stylex.create({
  /** 表格上方的过滤与分页控制栏。 */
  toolbar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: 10,
    marginBottom: 12,
  },
  toolbarControl: {
    height: 44,
    minHeight: 44,
    paddingTop: 0,
    paddingBottom: 0,
    fontSize: '.88rem',
  },
  pagination: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 10,
    '@media (max-width: 600px)': { width: '100%' },
  },
  pageSizeGroup: { display: 'flex', alignItems: 'center', gap: 8 },
  inlineLabel: { marginBottom: 0, whiteSpace: 'nowrap' },

  filterBox: {
    flex: '1 1 220px',
    minWidth: 0,
  },

  /** 每页条数选择器属于控件而非文本框：保持其自适应的自然宽度。 */
  pageSize: {
    width: 'auto',
    minWidth: 82,
  },

  /** 列标题本身作为排序触发控件，因此继承标题自身的排版样式。 */
  sortButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: 0,
    border: 0,
    background: 'none',
    font: 'inherit',
    color: 'inherit',
    textTransform: 'inherit',
    letterSpacing: 'inherit',
    cursor: 'pointer',
  },

  sortMark: {
    fontSize: '.72em',
    lineHeight: 1,
  },
});
