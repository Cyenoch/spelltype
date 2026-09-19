import * as stylex from '@stylexjs/stylex';

/** 管理控制台是一个居中卡片面板；状态卡片内嵌其中。 */
export const styles = stylex.create({
  page: { maxWidth: 720, margin: '0 auto', width: '100%' },
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
