/**
 * 个人资料视图：其异步统计数据加载以及玩家在对局结算后回溯查阅的持久化历史战绩。
 */
import { expect, type Page } from '@playwright/test';
import { gotoApp } from './app';

/** 当加载指示器消失、未显示错误且对局数为数字时，个人资料加载完成。 */
async function waitForProfileLoaded(page: Page): Promise<void> {
  await expect(page.getByTestId('view-profile')).toBeVisible();
  await expect(page.getByTestId('profile-stats')).toBeVisible();
  await expect(page.getByTestId('profile-loading')).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId('profile-error')).toBeHidden();
  await expect
    .poll(
      async () =>
        /^\d/.test(((await page.getByTestId('profile-games').textContent()) ?? '').trim()),
      { timeout: 30_000 },
    )
    .toBe(true);
}

/**
 * 打开个人资料视图并等待其数据加载完成。视图及其统计卡片是同步渲染的（对局数卡片初始为占位符），
 * 因此通过加载指示器、错误文本以及对局数变为纯数字来观测加载完成。
 */
export async function openProfile(page: Page): Promise<void> {
  if (!(await page.getByTestId('home-profile').isVisible())) await gotoApp(page);
  await page.getByTestId('home-profile').click();
  await waitForProfileLoaded(page);
}

export interface HistoryRow {
  matchId: string;
  theme: string;
  /** 该玩家造成的战斗伤害数值。 */
  damage: number | null;
  /** 对局结算时的剩余生命值。 */
  hp: number | null;
  /** 该玩家完成的法术数。 */
  spells: number | null;
  rank: number;
  cpm: number;
  accuracy: string;
  created: string;
  text: string;
}

/** 单元格的数值，仅在单元格内容为纯数字时提取。 */
function bareNumber(text: string): number | null {
  const raw = text.trim();
  return /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
}

export async function historyRows(page: Page): Promise<HistoryRow[]> {
  // 绝不在异步加载完成前读取表格（零行记录的账号也是合法状态）。
  await waitForProfileLoaded(page);
  const rows = await page.getByTestId('history-row').all();
  return Promise.all(
    rows.map(async (row) => {
      const textOf = async (id: string) => ((await row.getByTestId(id).textContent()) ?? '').trim();
      return {
        matchId: (await row.getAttribute('data-match-id')) ?? '',
        theme: await textOf('history-theme'),
        damage: bareNumber(await textOf('history-damage')),
        hp: bareNumber(await textOf('history-hp')),
        spells: bareNumber(await textOf('history-spells')),
        rank: Number((await textOf('history-rank')).replace(/[^\d-]/g, '') || 'NaN'),
        cpm: Number((await textOf('history-cpm')).replace(/[^\d-]/g, '') || 'NaN'),
        accuracy: await textOf('history-accuracy'),
        created: await textOf('history-created'),
        text: ((await row.textContent()) ?? '').trim(),
      };
    }),
  );
}
