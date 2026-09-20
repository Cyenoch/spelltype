import * as stylex from '@stylexjs/stylex';

/** 维护面板嵌入统一后台布局，保留现有状态与操作样式。 */
export const styles = stylex.create({
  page: { display: 'flex', flexDirection: 'column', gap: 20, width: '100%', minWidth: 0 },
  status: {
    marginTop: 16,
    backgroundColor: 'var(--panel)',
    backgroundImage: 'var(--surface-stone)',
    backgroundSize: '256px 256px',
  },
  modeRow: { display: 'flex', alignItems: 'baseline', gap: 12 },
  counters: { marginTop: 14, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
  actions: { marginTop: 18 },
  noticeError: {
    marginTop: 16,
    borderImageSource: 'var(--frame-control)',
    backgroundImage: 'linear-gradient(#57233166,#30151b99),var(--surface-stone)',
    backgroundSize: 'auto,256px 256px',
    backgroundRepeat: 'no-repeat,repeat',
    color: '#ffd8de',
  },
});
