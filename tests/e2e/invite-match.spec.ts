/**
 * The invitation path end to end: a signed-out visitor opens an invite link, creates an account,
 * joins the private lobby, and two real players fight one continuous match to a persisted result.
 *
 * This is the only spec that covers "lobby → generation → countdown → combat → results → history"
 * in one run, so it is the gold path: the room's spell book reaches both clients, completion
 * damages the automatic target, and both players read the same board and the same stored row.
 */
import { expect } from '@playwright/test';
import { test } from '../support/test';
import { INITIAL_HEALTH } from '../../shared/protocol';
import { acceptedGeneration, fixture } from '../support/runtime';
import {
  battleMatchId,
  completeSpell,
  completionDamage,
  endReason,
  finalRows,
  playUntilFinished,
  resultBanner,
  saveStatus,
  seatHealth,
  selfSpellIndex,
  selfSpellsCast,
  spellText,
  waitForCombat,
  waitForMatchEnd,
} from '../support/combat';
import { rowFor, selfIdentity } from '../support/api';
import { gotoApp } from '../support/app';
import {
  createRoom,
  inviteUrl,
  occupiedSeat,
  occupiedSeats,
  setReady,
  startMatch,
  waitForLobbyPlayers,
} from '../support/lobby';
import { historyRows, openProfile } from '../support/profile';
import { newContext, signUp, signedInContext, uniqueName } from '../support/session';

test.beforeEach(async () => {
  await fixture().reset();
});

test('受邀玩家登录后加入，两名玩家完成整场对战后看到相同战绩', async ({ browser }) => {
  // Keep one full-motion match/rematch path; other scenarios use reduced motion.
  test.setTimeout(300_000);
  const host = await signedInContext(browser, 'host');
  await host.page.emulateMedia({ reducedMotion: 'no-preference' });
  const theme = '星陨图书馆的禁忌抄本';
  // Hard spells deal ~176 damage each, so one 2400 HP opponent falls after about 14 completions.
  const roomId = await createRoom(host.page, { theme });

  expect(await occupiedSeats(host.page).count()).toBe(1);
  expect(await host.page.getByTestId('room-theme').textContent()).toContain(theme);
  const invite = await inviteUrl(host.page);
  expect(invite).toContain(`?room=${roomId}`);

  // A signed-out visitor joins by code from the home dialog: the destination survives the
  // auth flow. A malformed code keeps the dialog open and flags the field; uppercase input
  // and stray spaces are trimmed and lowercased before the room is resolved.
  const guestContext = await newContext(browser, { reducedMotion: 'no-preference' });
  const guestPage = await guestContext.newPage();
  await gotoApp(guestPage, '/');
  await guestPage.getByTestId('home-join-room').click();
  await expect(guestPage.getByTestId('join-room-dialog')).toBeVisible();
  await guestPage.getByTestId('join-room-code').fill('g'.repeat(24));
  await guestPage.getByTestId('join-room-submit').click();
  await expect(guestPage.getByTestId('join-room-dialog')).toBeVisible();
  await expect(guestPage.getByTestId('join-room-code')).toHaveAttribute('aria-invalid', 'true');
  await guestPage.getByTestId('join-room-code').fill(`  ${roomId.toUpperCase()}  `);
  await guestPage.getByTestId('join-room-submit').click();
  await expect(guestPage.getByTestId('view-auth')).toBeVisible();
  await expect(guestPage.getByTestId('invite-notice')).toContainText(roomId);
  const guestName = uniqueName('guest');
  await signUp(guestPage, guestName);
  await expect(guestPage.getByTestId('view-room')).toBeVisible();
  await expect(guestPage.getByTestId('lobby-panel')).toBeVisible();

  await waitForLobbyPlayers(host.page, [host.username, guestName]);
  await setReady(guestPage, true);
  await expect(occupiedSeat(host.page, guestName)).toHaveAttribute('data-ready', 'true');
  await fixture().setDelay(6000);

  await host.page.getByTestId('lobby-start').click();
  for (const page of [host.page, guestPage]) {
    await expect(page.getByTestId('view-generation')).toBeVisible();
    await expect(page.getByTestId('battle-panel')).toBeHidden();
  }
  await expect(guestPage.getByTestId('battle-panel')).toBeVisible({ timeout: 30_000 });
  await Promise.all([waitForCombat(host.page), waitForCombat(guestPage)]);

  // The match really asked the model for one book, and both clients got that book in order.
  const book = acceptedGeneration(await fixture().state()).generation.texts;

  const hostIdentity = await selfIdentity(host.context);
  const guestIdentity = await selfIdentity(guestContext);

  // Both players open on the same first spell of the shared book, and finishing it advances only
  // the finisher's own cursor: nobody waits for an opponent to answer.
  expect(await spellText(host.page)).toBe(book[0]);
  expect(await spellText(guestPage)).toBe(book[0]);
  expect(await selfSpellIndex(host.page)).toBe(0);
  expect(await completeSpell(host.page)).toBe(book[0]);
  expect(await selfSpellIndex(host.page)).toBe(1);
  expect(await spellText(host.page)).toBe(book[1]);
  expect(await spellText(guestPage)).toBe(book[0]);
  expect(await selfSpellsCast(guestPage)).toBe(0);

  // The guest fights back for real: two completions whose damage must show on the host's own seat.
  const guestSpells = [await completeSpell(guestPage), await completeSpell(guestPage)];
  expect(guestSpells).toEqual([book[0], book[1]]);
  const guestDamage = guestSpells.reduce((sum, text) => sum + completionDamage(text), 0);
  await expect
    .poll(async () => (await seatHealth(host.page, hostIdentity.userId)).hp)
    .toBe(INITIAL_HEALTH - guestDamage);

  // The host plays the rest of the single combat phase out; the guest's health runs out first.
  await playUntilFinished(host.page);
  await Promise.all([waitForMatchEnd(host.page), waitForMatchEnd(guestPage)]);
  expect(await endReason(host.page)).toBe('elimination');
  const matchIdValue = await battleMatchId(host.page);

  const hostRows = await finalRows(host.page);
  const guestRows = await finalRows(guestPage);
  expect(hostRows).toHaveLength(2);
  expect(hostRows.map((row) => row.rank).sort((a, b) => a - b)).toEqual([1, 2]);

  const hostRow = rowFor(hostRows, hostIdentity)!;
  const guestRow = rowFor(hostRows, guestIdentity)!;
  // The winner is the last player standing; the opponent was eliminated at exactly 0 HP.
  expect(hostRow.rank).toBe(1);
  expect(guestRow.rank).toBe(2);
  expect(guestRow.hp).toBe(0);

  // Both viewers read the same board: one row per identity, identical on both pages.
  for (const identity of [hostIdentity, guestIdentity]) {
    const fromHost = rowFor(hostRows, identity)!;
    const fromGuest = rowFor(guestRows, identity)!;
    expect(fromGuest.rank).toBe(fromHost.rank);
    expect(fromGuest.hp).toBe(fromHost.hp);
    expect(fromGuest.damage).toBe(fromHost.damage);
    expect(fromGuest.spells).toBe(fromHost.spells);
  }

  // Settlement replaces combat with a dedicated, immediately visible outcome page.
  const banner = await resultBanner(host.page);
  expect(banner.outcome).toBe('win');
  expect(banner.endReason).toBe('elimination');
  expect((await resultBanner(guestPage)).outcome).toBe('loss');
  for (const [page, title] of [
    [host.page, '胜利'],
    [guestPage, '失败'],
  ] as const) {
    await expect(page.getByTestId('view-results')).toBeVisible();
    await expect(page.getByTestId('battle-panel')).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeInViewport();
    await expect(page.getByTestId('rematch')).toBeInViewport();
    await expect(page.getByTestId('result-title')).toBeFocused();
  }

  await expect.poll(() => saveStatus(host.page), { timeout: 30_000 }).toBe('saved');

  // A second match must reuse a live arena, not render into a detached first-match host.
  await host.page.getByTestId('rematch').click();
  await expect(host.page.getByTestId('lobby-panel')).toBeVisible();
  await expect(guestPage.getByTestId('lobby-panel')).toBeVisible();
  await expect(host.page.getByTestId('view-results')).toBeHidden();
  await expect(guestPage.getByTestId('view-results')).toBeHidden();
  await setReady(guestPage, true);
  await startMatch(host.page);
  await Promise.all([waitForCombat(host.page), waitForCombat(guestPage)]);
  expect(await battleMatchId(host.page)).not.toBe(matchIdValue);
  await expect(host.page.getByTestId('battle-canvas-wrap').locator('canvas')).toBeVisible();
  await completeSpell(host.page);
  expect(await selfSpellsCast(host.page)).toBe(1);

  // The persisted history row is the combat record of this match, and both players see it.
  await openProfile(host.page);
  const hostEntry = (await historyRows(host.page)).find((row) => row.matchId === matchIdValue);
  expect(hostEntry).toBeDefined();
  expect(hostEntry!.theme).toContain(theme);
  expect(hostEntry!.rank).toBe(hostRow.rank);
  expect(hostEntry!.damage).toBe(hostRow.damage);
  expect(hostEntry!.hp).toBe(hostRow.hp);

  await openProfile(guestPage);
  const guestHistory = await historyRows(guestPage);
  expect(guestHistory.filter((row) => row.matchId === matchIdValue)).toHaveLength(1);
  const guestEntry = guestHistory.find((row) => row.matchId === matchIdValue)!;
  expect(guestEntry.rank).toBe(guestRow.rank);
  expect(guestEntry.damage).toBe(guestRow.damage);
  expect(guestEntry.hp).toBe(guestRow.hp);
  expect(guestEntry.rank).not.toBe(hostEntry!.rank);

  await host.context.close();
  await guestContext.close();
});
