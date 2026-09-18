/**
 * Spec 10 — AI generation failures.
 *
 * The only simulated dependency is the DeepSeek HTTP response. Each failure class must be
 * distinguishable to the player, must leave the room usable, must not fall back to a fixed
 * question bank, and must respect the retry policy (only non-conforming output is retried).
 * The keyword checks below identify the *category*; the accompanying assertions prove the
 * room stays recoverable, so the tests do not pin incidental wording.
 *
 * Recovery has to mean a *usable match*, not merely "no error left on screen": every player
 * must open on the first spell of the accepted book, and that book must be the complete set of
 * distinct spells the room asked for — a short or repeated payload would still clear the error
 * yet leave the match without a book to play.
 */
import { expect, test } from '../support/test';
import { SPELL_BOOK_SIZE } from '../../shared/protocol';
import type { FixtureRequestLog } from '../support/fixture-server';
import { acceptedGeneration, acceptedGenerationTexts, fixture, generationTextsForRequest, runtime } from '../support/runtime';
import { battleMatchId, spellText, waitForCombat } from '../support/combat';
import {
  createRoom,
  gotoApp,
  newContext,
  occupiedSeats,
  openHome,
  setReady,
  settle,
  signUp,
  startMatch,
  testId,
  twoPlayerRoom,
  uniqueName,
  visibleErrorText,
} from '../support/ui';

/**
 * The book the room's own prompt asked for, as the model actually returned it: full size and
 * all texts distinct. Asserted against the request log, so it holds for both the streamed and
 * the non-streamed calls.
 */
function expectFullBook(request: FixtureRequestLog): void {
  expect(request.askedCount).toBe(SPELL_BOOK_SIZE);
  expect(request.returnedCount).toBe(SPELL_BOOK_SIZE);
  expect(request.distinctTexts).toBe(true);
}

test.beforeEach(async () => {
  await fixture().reset();
  await fixture().scenario({ mode: 'success', difficulty: 'normal' });
});

test('上游失败、非法输出与超时是不同类别，且房间始终可以重试', async ({ browser }) => {
  test.setTimeout(400_000);
  const room = await twoPlayerRoom(browser, { theme: '失败分类', difficulty: 'normal' });
  const host = room.host.page;
  await fixture().queue([{ mode: 'upstream', status: 503 }, { mode: 'invalid_schema' }, { mode: 'invalid_schema' }, { mode: 'hang' }]);

  // Upstream failure: distinct category, lobby intact, members and ready state preserved.
  await testId(host, 'lobby-start').click();
  await expect.poll(() => visibleErrorText(host), { timeout: 40_000 }).toContain('不可用');
  const upstreamText = await visibleErrorText(host);
  expect(upstreamText).not.toContain('超时');
  expect(upstreamText).not.toContain('不符合');
  await expect(testId(host, 'lobby-panel')).toBeVisible();
  await expect(testId(host, 'battle-panel')).toBeHidden();
  expect(await occupiedSeats(host).count()).toBe(2);
  await expect(testId(room.guest.page, 'lobby-ready')).toHaveAttribute('aria-pressed', 'true');

  // Non-conforming output: retried once, then reported as its own category.
  await testId(host, 'lobby-start').click();
  await expect.poll(() => visibleErrorText(host), { timeout: 60_000 }).toContain('不符合');
  const invalidText = await visibleErrorText(host);
  expect(invalidText).not.toContain('超时');

  // Timeout: its own category, no automatic retry of a paid call.
  await testId(host, 'lobby-start').click();
  await expect.poll(() => visibleErrorText(host), { timeout: 90_000 }).toContain('超时');
  const timeoutText = await visibleErrorText(host);
  expect(new Set([upstreamText, invalidText, timeoutText]).size).toBe(3);

  const state = await fixture().state();
  expect(state.requests.map((request) => request.responseMode)).toEqual(['upstream', 'invalid_schema', 'invalid_schema', 'hang']);
  await expect(testId(host, 'lobby-panel')).toBeVisible();

  // Recoverable: a later attempt really generates and the match runs — one uninterrupted combat
  // phase per player, both of them opening on the first spell of the accepted book.
  await startMatch(host);
  await Promise.all([waitForCombat(host), waitForCombat(room.guest.page)]);
  const afterRetry = await fixture().state();
  expect(afterRetry.requests.map((request) => request.responseMode).at(-1)).toBe('success');
  expectFullBook(acceptedGeneration(afterRetry).request);

  const firstSpell = acceptedGenerationTexts(afterRetry)[0];
  expect(await spellText(host)).toBe(firstSpell);
  expect(await spellText(room.guest.page)).toBe(firstSpell);

  await room.host.context.close();
  await room.guest.context.close();
});

test('不合格输出会重试一次，第二次成功后正常开局', async ({ browser }) => {
  test.setTimeout(240_000);
  const room = await twoPlayerRoom(browser, { theme: '结构重试', difficulty: 'normal' });
  await fixture().queue([{ mode: 'invalid_json' }, { mode: 'success' }]);

  await startMatch(room.host.page);
  await waitForCombat(room.host.page);
  const state = await fixture().state();
  expect(state.requests.map((request) => request.responseMode)).toEqual(['invalid_json', 'success']);
  // The retry succeeded with a real book, not with a placeholder the room would silently accept.
  expectFullBook(acceptedGeneration(state).request);
  expect(await spellText(room.host.page)).toBe(acceptedGenerationTexts(state)[0]);

  await room.host.context.close();
  await room.guest.context.close();
});

test('迟到的过期生成结果不会覆盖正在进行的比赛', async ({ browser }) => {
  test.setTimeout(300_000);
  const room = await twoPlayerRoom(browser, { theme: '过期响应', difficulty: 'normal' });
  await fixture().queue([{ mode: 'hang' }, { mode: 'success' }]);

  await testId(room.host.page, 'lobby-start').click();
  await expect.poll(() => visibleErrorText(room.host.page), { timeout: 90_000 }).toContain('超时');
  await expect(testId(room.host.page, 'lobby-panel')).toBeVisible();

  await startMatch(room.host.page);
  await Promise.all([waitForCombat(room.host.page), waitForCombat(room.guest.page)]);
  const liveMatchId = await battleMatchId(room.host.page);
  const liveText = await spellText(room.host.page);

  expect(await fixture().release()).toBe(1);
  // The held response is now delivered; give the server time to (wrongly) apply it.
  await settle(3000);

  // The released stale payload must not touch the running match: same match, same open spell,
  // and the opponent sees that same spell.
  expect(await battleMatchId(room.host.page)).toBe(liveMatchId);
  expect(await battleMatchId(room.guest.page)).toBe(liveMatchId);
  expect(await spellText(room.host.page)).toBe(liveText);
  expect(await spellText(room.guest.page)).toBe(liveText);

  const state = await fixture().state();
  expect(state.requests[0].releasedAt).toBeDefined();
  // The accepted generation is the one the room serves; the released stale payload came from the
  // held request, so its own first spell is a different text — a swap would show up as `liveText`.
  expect(acceptedGenerationTexts(state)[0]).toBe(liveText);
  expect(generationTextsForRequest(state, 0)[0]).not.toBe(liveText);

  await room.host.context.close();
  await room.guest.context.close();
});

test('未配置密钥的实例明确提示且不发起任何生成请求', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await newContext(browser, { baseUrl: runtime().noKeyAppUrl });
  const page = await context.newPage();
  await openHome(page);
  await expect(testId(page, 'home-ai-notice')).toHaveAttribute('data-state', 'missing');

  const hostName = uniqueName('nk');
  await signUp(page, hostName);
  const roomId = await createRoom(page, { theme: '未配置密钥', difficulty: 'easy' });

  const guestContext = await newContext(browser, { baseUrl: runtime().noKeyAppUrl });
  const guestPage = await guestContext.newPage();
  await openHome(guestPage);
  await signUp(guestPage, uniqueName('nk2'));
  await gotoApp(guestPage, `/?room=${roomId}`);
  await setReady(guestPage, true);

  const before = (await fixture().state()).requests.length;
  await testId(page, 'lobby-start').click();
  await expect.poll(() => visibleErrorText(page), { timeout: 30_000 }).toContain('未配置');
  expect((await fixture().state()).requests.length).toBe(before);
  await expect(testId(page, 'lobby-panel')).toBeVisible();

  const configured = await newContext(browser);
  const configuredPage = await configured.newPage();
  await openHome(configuredPage);
  await expect(testId(configuredPage, 'home-ai-notice')).toHaveAttribute('data-state', 'configured');

  await configured.close();
  await guestContext.close();
  await context.close();
});
