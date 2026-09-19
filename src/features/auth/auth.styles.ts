import * as stylex from '@stylexjs/stylex';

/** 微信登录视图的局部样式。 */
export const styles = stylex.create({
  /** 退出登录按钮行与上方的登录链接保持适度垂直间距。 */
  actionsSpaced: {
    marginTop: 14,
  },
  /** 登录入口是具备按钮样式的 <a> 锚点标签；去除默认链接下划线。 */
  link: {
    textDecoration: 'none',
  },
  title: {
    fontSize: 'clamp(1.9rem, 4.4vw, 3rem)',
  },
  h2Size: {
    fontSize: 'clamp(1.35rem, 2.6vw, 1.85rem)',
  },
  /** 正文内容保持文档的段落节奏与下边距。 */
  paragraph: {
    margin: '0 0 .85em',
  },
});
