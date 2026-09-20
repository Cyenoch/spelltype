import {
  escapeHtml,
  GUIDE_INTRO,
  GUIDE_START_STEPS,
  GUIDE_TITLE,
  HOME_INTRO,
  HOME_STEPS,
  HOME_TITLE,
  PRACTICE_TIPS,
  PRACTICE_TITLE,
  SITE_NAME,
  type PageSeo,
} from '../shared/seo';

/** 与交互页面共用文案的首屏摘要；不区分访客与爬虫，也不依赖登录/API。 */
export function renderPublicContent(seo: PageSeo): string {
  const list = (items: string[]) => items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  let body: string;
  if (seo.indexable) {
    const guide = seo.path === '/guide';
    body = `<h1>${escapeHtml(guide ? GUIDE_TITLE : HOME_TITLE)}</h1>
      <p>${escapeHtml(guide ? GUIDE_INTRO : HOME_INTRO)}</p>
      <section><h2>${escapeHtml(PRACTICE_TITLE)}</h2><ul>${list(PRACTICE_TIPS)}</ul></section>
      <section><h2>${guide ? '开局：匹配还是私人房' : '三步上手'}</h2>
      <ol>${list(guide ? GUIDE_START_STEPS : HOME_STEPS)}</ol></section>`;
  } else {
    body = `<h1>${seo.known ? '登录后开始打字练习' : '页面不存在'}</h1>`;
  }
  return `<main class="public-preview">
    <p>${escapeHtml(SITE_NAME)}</p>${body}
    <nav aria-label="公开页面"><a href="/">打字练习首页</a> · <a href="/guide">练习指南与游戏规则</a></nav>
    <p>阅读简介无需登录；互动打字练习与对战需要启用 JavaScript 并使用微信登录。</p>
  </main>`;
}
