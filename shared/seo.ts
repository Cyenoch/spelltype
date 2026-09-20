export const SITE_NAME = '咒文对决 · Spelltype';
export const HOME_TITLE = '在线打字练习：练速度与键盘熟练度';
export const HOME_INTRO =
  '用游戏练习打字速度、准确率和键盘熟练度。咒文对决把英文打字练习变成 2–4 人魔法对战：输入英文咒文，边练键盘，边与朋友切磋。';
export const HOME_STEPS = [
  '微信登录后快速匹配，或创建私人房把邀请码发给朋友。',
  '快速匹配自动开战；私人房准备就绪后，由房主开始。',
  '亲手输入英文咒文，练习字母、空格和标点；打完一条即可施法，同时命中所有存活对手。',
];
export const PRACTICE_TITLE = '在对战中练习打字，而不只是追求胜负';
export const PRACTICE_TIPS = [
  '打字速度：连续输入完整英文句子，练习连贯击键；匹配等待时也可以练习咒文。',
  '准确率：留意标红的错字，用退格修正后继续。先打准，再逐步加快速度。',
  '键盘熟练度：反复练习字母、空格和标点的位置。推荐使用电脑与实体键盘进行练习。',
];
export const GUIDE_TITLE = '打字练习指南：从第一秒到结算';
export const GUIDE_INTRO =
  '了解如何用咒文对决练习英文打字：开始匹配或邀请朋友，输入咒文、修正错字，在对战中练习打字速度、准确率和键盘熟练度。';
export const GUIDE_START_STEPS = [
  '快速匹配：寻找一名对手，随机选择一个预设主题；双方进入房间即自动开始，无需点准备。',
  '排队期间可练习咒文，完成一句后按 Enter 继续。练习成绩仅在当前页面保留，不计入战绩，也不影响匹配。',
  '私人房：创建后在大厅复制邀请码发给朋友；朋友在首页点击「加入房间」输入邀请码，2–4 人即可开打。',
  '两种入口都需要先微信登录；登录后每局的排名与数据都会保存到你的战绩。',
  '所有新对局统一使用困难咒文，目标约 39–50 个英文字符。私人房可自定主题；主题只换咒文内容，规则不变。',
];

const PUBLIC_PAGES = {
  '/': { title: `在线打字练习与英文打字游戏 - ${SITE_NAME}`, description: HOME_INTRO },
  '/guide': {
    title: `打字练习指南：速度、准确率与键盘熟练度 - ${SITE_NAME}`,
    description: GUIDE_INTRO,
  },
};
export const INDEXABLE_PATHS = ['/', '/guide'] as const;
const PRIVATE_TITLES: Record<string, string> = {
  '/auth': '微信登录',
  '/create': '创建练习房间',
  '/match': '匹配与打字练习',
  '/me': '我的练习战绩',
  '/admin': '后台总览',
  '/admin/users': '用户管理',
  '/admin/matches': '对局管理',
  '/admin/books': '咒文书管理',
  '/admin/maintenance': '系统维护',
};

export interface PageSeo {
  path: string;
  known: boolean;
  indexable: boolean;
  title: string;
  description: string;
}

export function pageSeo(pathname: string, search: string): PageSeo {
  const path = pathname.replace(/\/+$/, '') || '/';
  const publicPage = path === '/' || path === '/guide' ? PUBLIC_PAGES[path] : undefined;
  const detailSection = /^\/admin\/(users|matches|books)\/[^/]+$/.exec(path)?.[1];
  const privateTitle = Object.hasOwn(PRIVATE_TITLES, path)
    ? PRIVATE_TITLES[path]
    : detailSection === 'users'
      ? '用户详情'
      : detailSection === 'matches'
        ? '对局详情'
        : detailSection === 'books'
          ? '咒文书详情'
          : undefined;
  const query = new URLSearchParams(search);
  const transient = query.has('room') || query.has('error');
  const known = Boolean(publicPage || privateTitle);
  return {
    path,
    known,
    indexable: Boolean(publicPage && !transient),
    title: transient
      ? `加入练习房间与登录 - ${SITE_NAME}`
      : (publicPage?.title ?? `${privateTitle ?? '页面不存在'} - ${SITE_NAME}`),
    description:
      publicPage?.description ??
      '微信登录咒文对决，通过英文打字对战练习打字速度、准确率与键盘熟练度。',
  };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** 浏览器导航与初始 HTTP 文档使用同一份元信息；规范域名只来自部署配置。 */
export function renderSeoHead(seo: PageSeo, origin: string): string {
  const canonical = new URL(seo.path, origin).href;
  const image = new URL('/icons/app-512.png', origin).href;
  const meta = (attribute: 'name' | 'property', name: string, content: string) =>
    `<meta data-seo ${attribute}="${name}" content="${escapeHtml(content)}">`;
  const tags = [
    `<title data-seo>${escapeHtml(seo.title)}</title>`,
    meta('name', 'description', seo.description),
    meta(
      'name',
      'robots',
      seo.indexable ? 'index, follow, max-image-preview:large' : 'noindex, follow',
    ),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', SITE_NAME),
    meta('property', 'og:locale', 'zh_CN'),
    meta('property', 'og:title', seo.title),
    meta('property', 'og:description', seo.description),
    meta('property', 'og:image', image),
    meta('property', 'og:image:type', 'image/png'),
    meta('property', 'og:image:width', '512'),
    meta('property', 'og:image:height', '512'),
    meta('property', 'og:image:alt', '咒文对决 Spelltype 打字练习图标'),
    meta('name', 'twitter:card', 'summary'),
    meta('name', 'twitter:title', seo.title),
    meta('name', 'twitter:description', seo.description),
    meta('name', 'twitter:image', image),
    meta('name', 'twitter:image:alt', '咒文对决 Spelltype 打字练习图标'),
  ];
  if (seo.known) {
    tags.push(
      `<link data-seo rel="canonical" href="${escapeHtml(canonical)}">`,
      meta('property', 'og:url', canonical),
    );
  }
  if (seo.indexable) {
    const home = new URL('/', origin).href;
    const websiteId = `${home}#website`;
    const graph = [
      { '@type': 'WebSite', '@id': websiteId, name: SITE_NAME, url: home, inLanguage: 'zh-CN' },
      {
        '@type': 'WebPage',
        '@id': `${canonical}#webpage`,
        name: seo.title,
        description: seo.description,
        url: canonical,
        inLanguage: 'zh-CN',
        isPartOf: { '@id': websiteId },
        about: { '@type': 'Thing', name: '英文打字练习、打字速度与键盘熟练度' },
      },
    ];
    const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(
      /</g,
      '\\u003c',
    );
    tags.push(`<script data-seo type="application/ld+json">${json}</script>`);
  }
  return tags.join('\n');
}
