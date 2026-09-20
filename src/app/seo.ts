import { pageSeo, renderSeoHead } from '../../shared/seo';

export function updatePageSeo(pathname: string, search: string) {
  const origin =
    document.querySelector<HTMLMetaElement>('meta[name="site-origin"]')?.content ??
    window.location.origin;
  const template = document.createElement('template');
  template.innerHTML = renderSeoHead(pageSeo(pathname, search), origin);
  for (const element of document.head.querySelectorAll('[data-seo]')) element.remove();
  document.head.append(template.content);
}
