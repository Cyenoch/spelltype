/**
 * 各 spec 共用的浏览器外壳原语：应用的 `data-testid` 契约、导航、可见的错误面，以及在一笔
 * 没有可观察完成信号的写入之后使用的墙钟静置。这里的一切读取的都是玩家看到的同一个界面。
 * 测试环境同样使用 `settle`。
 */
import { expect, type Page } from '@playwright/test';

export async function gotoApp(page: Page, pathname = '/'): Promise<void> {
  await page.goto(pathname, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('app-root')).toBeVisible();
}

/** 打开应用并等待首页视图可交互。 */
export async function openHome(page: Page): Promise<void> {
  await gotoApp(page);
  await expect(page.getByTestId('view-home')).toBeVisible();
}

/** 玩家此刻真正能看到的所有错误文本（绝不只是控制台）。 */
export async function visibleErrorText(page: Page): Promise<string> {
  const parts: string[] = [];
  for (const id of [
    'room-error',
    'create-error',
    'auth-error',
    'queue-error',
    'toast',
    'graphics-warning',
  ]) {
    const locator = page.getByTestId(id);
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const element = locator.nth(index);
      if (await element.isVisible()) parts.push(((await element.textContent()) ?? '').trim());
    }
  }
  return parts.filter((part) => part.length > 0).join(' | ');
}

/** 等待一段固定的墙钟延时（用于没有可观察完成信号的写入之后）。 */
export function settle(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
