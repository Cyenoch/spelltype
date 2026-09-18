/**
 * Spec 2 — invitation flow, a full continuous health-combat match between two independent browser
 * sessions, and the persisted result both players can see afterwards.
 */
import { expect, test } from '../support/test';
import { INITIAL_HEALTH, SPELL_BOOK_SIZE } from '../../shared/protocol';
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
import {
  createRoom,
  gotoApp,
  hasNumber,
  historyRows,
  inviteUrl,
  newContext,
  occupiedSeat,
  occupiedSeats,
  openProfile,
  rowFor,
  selfIdentity,
  setReady,
  signUp,
  signedInContext,
  startMatch,
  testId,
  uniqueName,
  visibleErrorText,
  waitForLobbyPlayers,
} from '../support/ui';

test.beforeEach(async () => {
  await fixture().reset();
  // No difficulty: the fixture follows the length band stated in the room's own prompt, so one
  // default serves both the hard kill-driven match and the preset-theme band check below.
  await fixture().scenario({ mode: 'success' });
});

test('受邀玩家登录后加入，两名玩家完成整场对战后看到相同战绩', async ({ browser }) => {
  // Every spell is typed through the real field, so a full match needs the typing time itself.
  test.setTimeout(300_000);
  const host = await signedInContext(browser, 'host');
  const theme = '星陨图书馆的禁忌抄本';
  // Hard spells deal ~176 damage each, so one 2400 HP opponent falls after about 14 completions.
  const roomId = await createRoom(host.page, { theme, difficulty: 'hard' });

  expect(await occupiedSeats(host.page).count()).toBe(1);
  expect(await testId(host.page, 'room-theme').textContent()).toContain(theme);
  expect(await testId(host.page, 'room-difficulty').textContent()).toContain('困难');
  const invite = await inviteUrl(host.page);
  expect(invite).toContain(`?room=${roomId}`);

  // A signed-out visitor opens the invite: the destination survives the auth flow.
  const guestContext = await newContext(browser);
  const guestPage = await guestContext.newPage();
  await gotoApp(guestPage, `/?room=${roomId}`);
  await expect(testId(guestPage, 'view-auth')).toBeVisible();
  await expect(testId(guestPage, 'invite-notice')).toContainText(roomId);
  const guestName = uniqueName('guest');
  await signUp(guestPage, guestName);
  await expect(testId(guestPage, 'view-room')).toBeVisible();
  await expect(testId(guestPage, 'lobby-panel')).toBeVisible();

  await waitForLobbyPlayers(host.page, [host.username, guestName]);
  await setReady(guestPage, true);
  await expect(occupiedSeat(host.page, guestName)).toHaveAttribute('data-ready', 'true');

  await startMatch(host.page);
  await expect(testId(guestPage, 'battle-panel')).toBeVisible({ timeout: 30_000 });
  await Promise.all([waitForCombat(host.page), waitForCombat(guestPage)]);

  // This match really called the model: the request carried the room's own theme, and the payload
  // the room accepted is a full book of distinct spells. The room itself requires exactly
  // SPELL_BOOK_SIZE distinct in-band spells, so acceptance is what proves the size.
  const { request, generation } = acceptedGeneration(await fixture().state());
  const book = generation.texts;
  expect(request.schemaDetected).toBe(true);
  expect(request.prompt).toContain(theme);
  // The product's own book sentence asks for exactly the shared contract size, and the room
  // accepted exactly that many distinct spells.
  expect(request.askedCount).toBe(SPELL_BOOK_SIZE);
  expect(request.returnedCount).toBe(SPELL_BOOK_SIZE);
  expect(request.distinctTexts).toBe(true);
  expect(new Set(book).size).toBe(SPELL_BOOK_SIZE);

  const hostIdentity = await selfIdentity(host.context);
  const guestIdentity = await selfIdentity(guestContext);

  // Both players open on the same first spell of the shared book, and finishing it advances only
  // the finisher's own cursor: nobody waits for an opponent to answer.
  expect(await spellText(host.page)).toBe(book[0]);
  expect(await spellText(guestPage)).toBe(book[0]);
  expect(await selfSpellIndex(host.page)).toBe(0);
  expect(await selfSpellsCast(host.page)).toBe(0);
  expect(await completeSpell(host.page)).toBe(book[0]);
  expect(await selfSpellIndex(host.page)).toBe(1);
  expect(await selfSpellsCast(host.page)).toBe(1);
  expect(await spellText(host.page)).toBe(book[1]);
  expect(await spellText(guestPage)).toBe(book[0]);
  expect(await selfSpellsCast(guestPage)).toBe(0);

  // The guest fights back for real: two completions whose damage must show on the host's own seat.
  const guestSpells = [await completeSpell(guestPage), await completeSpell(guestPage)];
  expect(guestSpells).toEqual([book[0], book[1]]);
  const guestDamage = guestSpells.reduce((sum, text) => sum + completionDamage(text), 0);
  expect(guestDamage).toBeGreaterThan(0);
  await expect
    .poll(async () => (await seatHealth(host.page, hostIdentity.userId)).hp)
    .toBe(INITIAL_HEALTH - guestDamage);

  // The host plays the rest of the single combat phase out; the guest's health runs out first.
  await playUntilFinished(host.page);
  await Promise.all([waitForMatchEnd(host.page), waitForMatchEnd(guestPage)]);
  expect(await endReason(host.page)).toBe('elimination');
  const matchIdValue = await battleMatchId(host.page);
  expect(matchIdValue).toMatch(/^[0-9a-f-]{8,}$/);

  const hostRows = await finalRows(host.page);
  const guestRows = await finalRows(guestPage);
  expect(hostRows).toHaveLength(2);
  expect(hostRows.map((row) => row.rank).sort((a, b) => a - b)).toEqual([1, 2]);

  const hostRow = rowFor(hostRows, hostIdentity)!;
  const guestRow = rowFor(hostRows, guestIdentity)!;
  // The winner is the last player standing, with the damage, health and counters of a real match.
  expect(hostRow.rank).toBe(1);
  expect(hostRow.damage).toBeGreaterThan(0);
  expect(hostRow.hp).toBe(INITIAL_HEALTH - guestDamage);
  expect(hostRow.spells).toBeGreaterThan(0);
  expect(hostRow.cpm).toBeGreaterThan(0);
  expect(hostRow.spells).toBe(await selfSpellsCast(host.page));
  // The guest was eliminated at exactly 0 HP, having only dealt the two spells it completed.
  expect(guestRow.rank).toBe(2);
  expect(guestRow.hp).toBe(0);
  expect(guestRow.damage).toBe(guestDamage);
  expect(guestRow.spells).toBe(2);
  expect(hasNumber(hostRow.accuracy)).toBe(true);
  expect(hasNumber(guestRow.accuracy)).toBe(true);

  // Both viewers read the same board: one row per identity, identical on both pages.
  for (const identity of [hostIdentity, guestIdentity]) {
    const fromHost = rowFor(hostRows, identity)!;
    const fromGuest = rowFor(guestRows, identity)!;
    expect(fromGuest.rank).toBe(fromHost.rank);
    expect(fromGuest.hp).toBe(fromHost.hp);
    expect(fromGuest.damage).toBe(fromHost.damage);
    expect(fromGuest.spells).toBe(fromHost.spells);
  }

  // The banner is that same board: rank 1 won, the eliminated player is down, and the match ended
  // because a player fell rather than on the match deadline.
  const banner = await resultBanner(host.page);
  expect(banner.outcome).toBe('win');
  expect(banner.endReason).toBe('elimination');
  expect((await resultBanner(guestPage)).outcome).toBe('down');

  await expect.poll(() => saveStatus(host.page), { timeout: 30_000 }).toBe('saved');

  // The persisted history row is the combat record of this match: both players see it with the
  // ranks, damage and remaining health the final board showed.
  await openProfile(host.page);
  const hostEntry = (await historyRows(host.page)).find((row) => row.matchId === matchIdValue);
  expect(hostEntry).toBeDefined();
  expect(hostEntry!.theme).toContain(theme);
  expect(hostEntry!.rank).toBe(hostRow.rank);
  expect(hostEntry!.damage).toBe(hostRow.damage);
  expect(hostEntry!.hp).toBe(hostRow.hp);

  await openProfile(guestPage);
  const guestEntry = (await historyRows(guestPage)).find((row) => row.matchId === matchIdValue);
  expect(guestEntry).toBeDefined();
  expect(guestEntry!.rank).toBe(guestRow.rank);
  expect(guestEntry!.damage).toBe(guestRow.damage);
  expect(guestEntry!.hp).toBe(guestRow.hp);
  expect(guestEntry!.rank).not.toBe(hostEntry!.rank);
  expect(hasNumber((await testId(guestPage, 'profile-best-cpm').textContent()) ?? '')).toBe(true);

  await host.context.close();
  await guestContext.close();
});

test('房主可用预设主题与困难难度开局，文案长度落在困难区间', async ({ browser }) => {
  test.setTimeout(120_000);
  const host = await signedInContext(browser, 'preset');
  const roomId = await createRoom(host.page, { preset: 0, difficulty: 'hard' });
  // Pin the fixture to the hard band so the only variable left is the room's own validation: a room
  // that validated any other band would refuse this book and the match would never start.
  await fixture().queue([{ mode: 'success', difficulty: 'hard' }]);

  const guestContext = await newContext(browser);
  const guestPage = await guestContext.newPage();
  const guestName = uniqueName('pg');
  await guestPage.goto(`/?room=${roomId}`);
  await signUp(guestPage, guestName);
  await waitForLobbyPlayers(host.page, [host.username, guestName]);
  await setReady(guestPage, true);

  // Report whatever the room says if the match does not start, instead of a bare timeout.
  await testId(host.page, 'lobby-start').click();
  await expect
    .poll(
      async () => {
        if (await testId(host.page, 'battle-panel').isVisible()) return 'battle';
        const error = await visibleErrorText(host.page);
        return error ? `error: ${error}` : 'waiting for the match to start';
      },
      { timeout: 40_000 },
    )
    .toBe('battle');

  await Promise.all([waitForCombat(host.page), waitForCombat(guestPage)]);
  // The band is the length contract the room's own prompt asked for, and the whole accepted book
  // has to fall inside it — this is what the room validated the payload against.
  const { request, generation } = acceptedGeneration(await fixture().state());
  // The fixture followed the difficulty the room itself declared, which is the band the room then
  // validated the book against — a fallback to another band would be rejected as out-of-range.
  expect(request.difficulty).toBe('hard');
  const [min, max] = request.lengthRange;
  for (const text of generation.texts) {
    const length = [...text].length;
    expect(length).toBeGreaterThanOrEqual(min);
    expect(length).toBeLessThanOrEqual(max);
  }

  // Both players face the same first spell, and finishing it damages exactly the opponent it
  // targets, four points per code point, bounded by that opponent's remaining health.
  const first = await spellText(host.page);
  expect(await spellText(guestPage)).toBe(first);
  const guestIdentity = await selfIdentity(guestContext);
  const guestHpBefore = (await seatHealth(host.page, guestIdentity.userId)).hp;
  expect(guestHpBefore).toBe(INITIAL_HEALTH);
  expect(await completeSpell(host.page)).toBe(first);
  const damage = completionDamage(first, guestHpBefore);
  expect(damage).toBeGreaterThan(0);
  await expect
    .poll(async () => (await seatHealth(host.page, guestIdentity.userId)).hp)
    .toBe(guestHpBefore - damage);

  await host.context.close();
  await guestContext.close();
});
