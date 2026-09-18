/**
 * The profile view: its asynchronous stat load and the persisted match history a player reads back
 * after a settled match.
 */
import { expect, type Page } from '@playwright/test';
import { gotoApp } from './app';

/** The profile has finished loading when the spinner is gone, no error is shown and games is numeric. */
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
 * Opens the profile view and waits for its data load to finish. The view and its stat tiles are
 * rendered synchronously (the games tile starts as a placeholder), so the load is observed via the
 * loading indicator, the error text and the games figure becoming numeric.
 */
export async function openProfile(page: Page): Promise<void> {
  if (!(await page.getByTestId('home-profile').isVisible())) await gotoApp(page);
  await page.getByTestId('home-profile').click();
  await waitForProfileLoaded(page);
}

export interface HistoryRow {
  matchId: string;
  theme: string;
  /** Combat damage dealt by this player, as a plain figure. */
  damage: number | null;
  /** Remaining health when the match settled. */
  hp: number | null;
  /** Spells this player completed. */
  spells: number | null;
  rank: number;
  cpm: number;
  accuracy: string;
  created: string;
  text: string;
}

/** A cell's figure, but only when the cell is nothing but that figure. */
function bareNumber(text: string): number | null {
  const raw = text.trim();
  return /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : null;
}

export async function historyRows(page: Page): Promise<HistoryRow[]> {
  // Never read the table before the asynchronous load settled (a zero-row account is valid).
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
