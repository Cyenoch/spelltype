/**
 * Quick matchmaking: the two players a ticket pairs, the visible cancellation, and the release of a
 * reservation that the opponent never joined.
 *
 * The queue is shared by every account, so every scenario here cancels what it queued (and the
 * suite's auto fixture is the net for a failing test). The queue's own lease rules are asserted
 * through the API the client calls.
 */
import { expect, type Browser } from '@playwright/test';
import { test } from '../support/test';
import { INITIAL_HEALTH, type MatchTicket, type Profile } from '../../shared/protocol';
import { fixture } from '../support/runtime';
import { apiJson, selfIdentity } from '../support/api';
import { battlePhase, roomSnapshot, snapshotPlayer } from '../support/combat';
import { gotoApp, openHome, settle, visibleErrorText } from '../support/app';
import { signedInContext, type Session } from '../support/session';

test.beforeEach(async () => {
  await fixture().reset();
});

/** Queues or polls the single matchmaking ticket; the endpoint is idempotent per account. */
async function matchTicket(session: Session) {
  return apiJson<MatchTicket>(session.context, '/api/match', { method: 'POST' });
}

test('两名玩家经界面配对进入同一房间并自动开局', async ({ browser }) => {
  const first = await signedInContext(browser, 'ui1');
  const second = await signedInContext(browser, 'ui2');
  await openHome(first.page);
  await openHome(second.page);
  await fixture().setDelay(6000);

  await first.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('view-queue')).toBeVisible();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting');

  // A slow room read must keep the matched queue visible until room admission completes.
  const roomRequested = Promise.withResolvers<void>();
  const releaseRoom = Promise.withResolvers<void>();
  await first.page.route(/\/api\/rooms\/[0-9a-f]{24}$/, async (route) => {
    roomRequested.resolve();
    await releaseRoom.promise;
    await route.continue();
  });

  await second.page.getByTestId('home-quick-start').click();
  await roomRequested.promise;
  try {
    await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'matched');
    await settle(1200);
    await expect(first.page.getByTestId('view-queue')).toBeVisible();
  } finally {
    releaseRoom.resolve();
  }

  // Both players are sent to the same room; a quick room may already be past the lobby by the
  // time both connect, so wait for the room view and read its authoritative room id. The
  // generation stage is its own surface now: lobby, combat or generation all count as arrived.
  for (const page of [first.page, second.page]) {
    await expect(page.getByTestId('view-room')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          (await page.getByTestId('lobby-panel').isVisible()) ||
          (await page.getByTestId('battle-panel').isVisible()) ||
          (await page.getByTestId('spell-generation').isVisible()),
        { timeout: 30_000 },
      )
      .toBe(true);
  }
  const firstRoomId =
    (await first.page.getByTestId('view-room').getAttribute('data-room-id')) ?? '';
  const secondRoomId =
    (await second.page.getByTestId('view-room').getAttribute('data-room-id')) ?? '';
  expect(firstRoomId).toMatch(/^[0-9a-f]{24}$/);
  expect(secondRoomId).toBe(firstRoomId);

  // Both connected → the reserved quick room starts on its own. A warm preset book can skip
  // past the generating surface almost instantly, so arrival is proven by the playing phase
  // (and the hidden generation surface) rather than by catching that surface mid-flight.
  for (const page of [first.page, second.page]) {
    await expect(page.getByTestId('battle-panel')).toHaveAttribute('data-phase', 'playing', {
      timeout: 40_000,
    });
    await expect(page.getByTestId('spell-generation')).toBeHidden();
    await expect(page.getByTestId('typing-input')).toBeVisible();
  }

  // A started match can no longer honestly report a cancellation.
  const cancelled = await apiJson<{ cancelled: boolean }>(first.context, '/api/match', {
    method: 'DELETE',
  });
  expect(cancelled.body.cancelled).toBe(false);

  await first.context.close();
  await second.context.close();
});

test('取消会如实反馈：等待中可重新排队，准备阶段的取消会释放已连接的对手', async ({ browser }) => {
  test.setTimeout(300_000);
  const first = await signedInContext(browser, 'cancel1');
  const second = await signedInContext(browser, 'cancel2');

  // Queueing alone, then cancelling: the state is visible, no hidden room is created, and the
  // player can queue again.
  await openHome(first.page);
  await first.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting', {
    timeout: 20_000,
  });
  await expect(first.page.getByTestId('queue-elapsed')).toBeVisible();
  await first.page.getByTestId('queue-cancel').click();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'cancelled', {
    timeout: 20_000,
  });
  await expect(first.page.getByTestId('view-room')).toBeHidden();
  await first.page.getByTestId('queue-requeue').click();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting', {
    timeout: 20_000,
  });
  await first.page.getByTestId('queue-cancel').click();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'cancelled', {
    timeout: 20_000,
  });

  // Leaving during a delayed enqueue must not leave an opponent-matchable orphan ticket.
  const pending = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await first.page.route('**/api/match', async (route) => {
    if (route.request().method() === 'POST') {
      pending.resolve();
      await release.promise;
    }
    await route.continue();
  });
  await first.page.getByTestId('queue-requeue').click();
  await pending.promise;
  const cancelled = first.page.waitForResponse(
    (response) => response.url().endsWith('/api/match') && response.request().method() === 'DELETE',
  );
  await first.page.getByTestId('queue-home').click();
  await Promise.race([cancelled, settle(500)]);
  release.resolve();
  await cancelled;
  await first.page.unroute('**/api/match');
  expect((await matchTicket(second)).body.state).toBe('waiting');
  await apiJson(second.context, '/api/match', { method: 'DELETE' });

  // The opponent cancels while this player is already in the prepared lobby: the connected player
  // must be released instead of being left in a hidden room, and can queue again.
  await matchTicket(second);
  await matchTicket(first);
  const matchedFirst = await matchTicket(first);
  const matchedSecond = await matchTicket(second);
  expect(matchedFirst.body.state).toBe('matched');
  const roomId = matchedFirst.body.roomId!;
  expect(matchedSecond.body.roomId).toBe(roomId);

  await gotoApp(first.page, `/?room=${roomId}`);
  await expect(first.page.getByTestId('lobby-panel')).toBeVisible({ timeout: 30_000 });
  expect(
    (await apiJson<{ cancelled: boolean }>(second.context, '/api/match', { method: 'DELETE' })).body
      .cancelled,
  ).toBe(true);

  await expect
    .poll(async () => first.page.getByTestId('connection-status').getAttribute('data-state'), {
      timeout: 20_000,
    })
    .toMatch(/closed|reconnecting/);
  await expect.poll(() => visibleErrorText(first.page), { timeout: 20_000 }).not.toBe('');
  await expect(first.page.getByTestId('battle-panel')).toBeHidden();
  // The other seat was deleted by cancellation: the notice must still let this
  // player recover when the targeted leave answers that the seat is gone.
  await first.page.getByTestId('room-error-retry').click();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting');
  await first.page.getByTestId('queue-cancel').click();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'cancelled');

  await first.context.close();
  await second.context.close();
});

test('房间读取失败后返回首页：释放旧席位，重新匹配进入新房间', async ({ browser }) => {
  const first = await signedInContext(browser, 'recover1');
  const second = await signedInContext(browser, 'recover2');
  await matchTicket(first);
  const paired = await matchTicket(second);
  const roomId = paired.body.roomId!;
  expect((await matchTicket(first)).body.roomId).toBe(roomId);

  // A snapshot failure must not turn the reserved seat into a room-entry loop.
  await first.page.route(`**/api/rooms/${roomId}`, (route) =>
    route.fulfill({ status: 500, json: { error: '房间暂时不可用' } }),
  );
  await first.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('room-error')).toBeVisible();
  await expect(first.page.getByTestId('connection-status')).toHaveAttribute('data-state', 'closed');

  // Failed cleanup is not a successful exit; retry keeps the same reservation
  // until the server acknowledges it, even when the original snapshot is absent.
  const leaveUrl = `**/api/rooms/${roomId}/leave`;
  await first.page.route(leaveUrl, (route) => route.abort('connectionfailed'));
  await first.page.getByTestId('room-error-home').click();
  await expect(first.page.locator('[data-testid="toast"] > [data-tone="error"]')).toBeVisible();
  await expect(first.page.getByTestId('room-error-home')).toBeEnabled();
  await expect(first.page.getByTestId('view-home')).toBeHidden();
  expect((await matchTicket(first)).body.roomId).toBe(roomId);
  await first.page.unroute(leaveUrl);

  const leaveArrived = Promise.withResolvers<void>();
  const releaseLeave = Promise.withResolvers<void>();
  await first.page.route(leaveUrl, async (route) => {
    leaveArrived.resolve();
    await releaseLeave.promise;
    await route.continue();
  });
  await first.page.getByTestId('room-error-home').click();
  await leaveArrived.promise;
  await expect(first.page.getByTestId('room-error-home')).toBeDisabled();
  await expect(first.page.getByTestId('view-home')).toBeHidden();
  releaseLeave.resolve();
  await expect(first.page.getByTestId('view-home')).toBeVisible();

  const nextPoll = first.page.waitForResponse(
    (response) => response.url().endsWith('/api/match') && response.request().method() === 'POST',
  );
  await first.page.getByTestId('home-quick-start').click();
  expect((await (await nextPoll).json()).state).toBe('waiting');
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting');
  const next = await matchTicket(second);
  expect(next.body.state).toBe('matched');
  expect(next.body.roomId).not.toBe(roomId);
  await expect(first.page.getByTestId('view-room')).toHaveAttribute(
    'data-room-id',
    next.body.roomId!,
  );
  await expect(first.page.getByTestId('lobby-panel')).toBeVisible();
  await expect(first.page.getByTestId('room-error')).toBeHidden();

  // A replaced window's way home is local only: it must not cancel the room now
  // controlled by the new window of the same account.
  const replacement = await first.context.newPage();
  await gotoApp(replacement, `/?room=${next.body.roomId!}`);
  await expect(replacement.getByTestId('lobby-panel')).toBeVisible();
  await expect(first.page.getByTestId('room-error')).toBeVisible();
  await first.page.getByTestId('room-error-home').click();
  await expect(first.page.getByTestId('view-home')).toBeVisible();
  expect((await matchTicket(second)).body.roomId).toBe(next.body.roomId);
  await expect(replacement.getByTestId('connection-status')).toHaveAttribute('data-state', 'open');

  await first.context.close();
  await second.context.close();
});

test('排队租约只前移，并发轮询不会自我匹配', async ({ browser }) => {
  const first = await signedInContext(browser, 'qa');
  const second = await signedInContext(browser, 'qb');

  const waiting = await matchTicket(first);
  expect(waiting.body.state).toBe('waiting');
  expect(typeof waiting.body.expiresAt).toBe('number');

  // Polling refreshes a waiting entry's lease: the state stays 'waiting' and the expiry
  // only ever moves forward (it is a lease, not a frozen value).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect((await matchTicket(first)).body.expiresAt).toBeGreaterThanOrEqual(
      waiting.body.expiresAt,
    );
    await settle(300);
  }

  // Repeating the poll while alone never pairs the account with itself.
  const alone = await Promise.all([matchTicket(first), matchTicket(first), matchTicket(first)]);
  expect(alone.every((response) => response.body.state === 'waiting')).toBe(true);

  // Seeding one account and then enqueueing the partner pairs them.
  await matchTicket(second);
  const matchedFirst = await matchTicket(first);
  const matchedSecond = await matchTicket(second);
  expect(matchedFirst.body.state).toBe('matched');
  expect(matchedSecond.body.state).toBe('matched');
  expect(matchedFirst.body.roomId).toMatch(/^[0-9a-f]{24}$/);
  expect(matchedSecond.body.roomId).toBe(matchedFirst.body.roomId);

  const snapshot = await roomSnapshot(first.context, matchedFirst.body.roomId!);
  expect(snapshot.mode).toBe('quick');
  expect(snapshot.players).toHaveLength(2);
  expect(new Set(snapshot.players.map((player) => player.id)).size).toBe(2);
  expect(snapshot.players.filter((player) => player.id === snapshot.hostId)).toHaveLength(1);

  // Cancelling a live reservation is reported honestly, and the released player can queue again.
  expect(
    (await apiJson<{ cancelled: boolean }>(first.context, '/api/match', { method: 'DELETE' })).body
      .cancelled,
  ).toBe(true);
  const requeued = await matchTicket(first);
  expect(
    requeued.body.state === 'waiting' || requeued.body.roomId !== matchedFirst.body.roomId,
  ).toBe(true);
  // Re-polling may have re-queued the account: cancel again so no reservation leaks into the
  // shared queue (the afterEach cleanup is the safety net, this is the intent).
  expect(
    (await apiJson<{ cancelled: boolean }>(first.context, '/api/match', { method: 'DELETE' })).body
      .cancelled,
  ).toBe(true);
  expect(
    (await apiJson<{ cancelled: boolean }>(second.context, '/api/match', { method: 'DELETE' })).body
      .cancelled,
  ).toBe(true);

  await first.context.close();
  await second.context.close();
});

/** Seeds a quick pairing over the API, then starts a real match through the UI for both players. */
async function startedQuickMatch(
  browser: Browser,
  prefix: string,
): Promise<{ leaver: Session; keeper: Session; roomId: string }> {
  const leaver = await signedInContext(browser, `${prefix}a`);
  const keeper = await signedInContext(browser, `${prefix}b`);
  await matchTicket(keeper);
  const matched = await matchTicket(leaver);
  expect(matched.body.state).toBe('matched');
  const roomId = matched.body.roomId!;
  expect((await matchTicket(keeper)).body.roomId).toBe(roomId);
  for (const session of [leaver, keeper]) {
    await gotoApp(session.page, `/?room=${roomId}`);
  }
  for (const session of [leaver, keeper]) {
    await expect(session.page.getByTestId('battle-panel')).toHaveAttribute(
      'data-phase',
      'playing',
      { timeout: 60_000 },
    );
  }
  return { leaver, keeper, roomId };
}

test('对局中手动离开：确认后才返回首页，失利入档且可重新匹配新房间', async ({ browser }) => {
  test.setTimeout(300_000);
  const { leaver, keeper, roomId } = await startedQuickMatch(browser, 'lv');

  // The leave request is held at the network: nothing may claim success, navigate away or
  // requeue before the server has actually committed the departure.
  let leaveRequests = 0;
  const leaveArrived = Promise.withResolvers<void>();
  const releaseLeave = Promise.withResolvers<void>();
  await leaver.page.route(/\/api\/rooms\/[0-9a-f]{24}\/leave$/, async (route) => {
    leaveRequests += 1;
    leaveArrived.resolve();
    await releaseLeave.promise;
    await route.continue();
  });

  await leaver.page.getByTestId('battle-leave').click();
  await leaveArrived.promise;
  await settle(300);
  await expect(leaver.page.getByTestId('view-room')).toBeVisible();
  await expect(leaver.page.getByTestId('view-home')).toBeHidden();

  // Duplicate clicks share the one in-flight request instead of re-firing it.
  await leaver.page.getByTestId('battle-leave').click();
  await settle(300);
  expect(leaveRequests).toBe(1);

  releaseLeave.resolve();
  await expect(leaver.page.getByTestId('view-home')).toBeVisible({ timeout: 20_000 });
  await expect(leaver.page.getByTestId('view-room')).toBeHidden();

  // The forfeited duel is durably recorded for the leaver: out of the match, ranked behind
  // the survivor, with a persisted result row.
  const leaverIdentity = await selfIdentity(leaver.context);
  await expect
    .poll(async () => (await apiJson<Profile>(leaver.context, '/api/profile')).body.stats.games, {
      timeout: 30_000,
    })
    .toBe(1);
  const leaverRecord = (await apiJson<Profile>(leaver.context, '/api/profile')).body.history;
  expect(leaverRecord).toHaveLength(1);
  expect(leaverRecord[0].hp_remaining).toBe(0);
  expect(leaverRecord[0].rank).toBe(2);

  // The surviving room keeps its settled result with the leaver marked out.
  await expect
    .poll(async () => (await roomSnapshot(keeper.context, roomId)).phase, { timeout: 30_000 })
    .toBe('finished');
  const settled = await roomSnapshot(keeper.context, roomId);
  expect(settled.endReason).toBe('elimination');
  const leaverSeat = snapshotPlayer(settled, leaverIdentity);
  expect(leaverSeat.hp).toBe(0);
  expect(leaverSeat.eliminatedAt).not.toBeNull();
  expect(leaverSeat.rank).toBe(2);

  // Re-queuing pairs the returned player into a NEW room, never the abandoned one.
  const late = await signedInContext(browser, 'lvz');
  await leaver.page.getByTestId('home-quick-start').click();
  await expect(leaver.page.getByTestId('view-queue')).toBeVisible();
  await expect(leaver.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting', {
    timeout: 20_000,
  });
  await matchTicket(late);
  await expect
    .poll(async () => (await matchTicket(late)).body.state, { timeout: 30_000 })
    .toBe('matched');
  const newRoomId = (await matchTicket(late)).body.roomId!;
  expect(newRoomId).toMatch(/^[0-9a-f]{24}$/);
  expect(newRoomId).not.toBe(roomId);
  await expect(leaver.page.getByTestId('view-room')).toBeVisible({ timeout: 30_000 });
  await expect(leaver.page.getByTestId('view-room')).toHaveAttribute('data-room-id', newRoomId);

  await leaver.context.close();
  await keeper.context.close();
  await late.context.close();
});

test('离开请求失败：如实报错、留在房间不误判离席，重试后才真正离开', async ({ browser }) => {
  test.setTimeout(300_000);
  const { leaver, keeper, roomId } = await startedQuickMatch(browser, 'lf');
  const leaverIdentity = await selfIdentity(leaver.context);

  // The request never reaches the server: the failure is announced, nothing is claimed and
  // nothing is committed.
  await leaver.page.route(/\/api\/rooms\/[0-9a-f]{24}\/leave$/, (route) =>
    route.abort('connectionfailed'),
  );
  await leaver.page.getByTestId('battle-leave').click();
  await expect(leaver.page.locator('[data-testid="toast"] > [data-tone="error"]')).toBeVisible();
  await expect(leaver.page.getByTestId('view-room')).toBeVisible();
  expect(await battlePhase(leaver.page)).toBe('playing');

  // The seat is untouched: no silent forfeit, the match simply continues.
  const untouched = await roomSnapshot(keeper.context, roomId);
  expect(untouched.phase).toBe('playing');
  expect(snapshotPlayer(untouched, leaverIdentity).eliminatedAt).toBeNull();
  expect(snapshotPlayer(untouched, leaverIdentity).hp).toBe(INITIAL_HEALTH);

  // The same button retries over a healthy network and completes the departure.
  await leaver.page.unroute(/\/api\/rooms\/[0-9a-f]{24}\/leave$/);
  await leaver.page.getByTestId('battle-leave').click();
  await expect(leaver.page.getByTestId('view-home')).toBeVisible({ timeout: 20_000 });
  await expect(leaver.page.getByTestId('view-room')).toBeHidden();
  await expect
    .poll(async () => (await apiJson<Profile>(leaver.context, '/api/profile')).body.stats.games, {
      timeout: 30_000,
    })
    .toBe(1);
  const record = (await apiJson<Profile>(leaver.context, '/api/profile')).body.history;
  expect(record).toHaveLength(1);
  expect(record[0].hp_remaining).toBe(0);

  await leaver.context.close();
  await keeper.context.close();
});

test('离场已提交但响应丢失：重试确认，不重复结算', async ({ browser }) => {
  test.setTimeout(300_000);
  const { leaver, keeper, roomId } = await startedQuickMatch(browser, 'la');
  let committedStatus = 0;
  const leavePath = /\/api\/rooms\/[0-9a-f]{24}\/leave$/;
  await leaver.page.route(leavePath, async (route) => {
    const response = await route.fetch();
    committedStatus = response.status();
    await route.abort('connectionfailed');
  });

  await leaver.page.getByTestId('battle-leave').click();
  await expect(leaver.page.locator('[data-testid="toast"] > [data-tone="error"]')).toBeVisible();
  expect(committedStatus).toBe(200);
  await expect(leaver.page.getByTestId('view-home')).toBeHidden();
  expect((await roomSnapshot(keeper.context, roomId)).phase).toBe('finished');

  await leaver.page.unroute(leavePath);
  await leaver.page
    .locator('[data-testid="battle-leave"]:visible, [data-testid="final-leave"]:visible')
    .click();
  await expect(leaver.page.getByTestId('view-home')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => (await apiJson<Profile>(leaver.context, '/api/profile')).body.stats.games, {
      timeout: 30_000,
    })
    .toBe(1);
  await leaver.context.close();
  await keeper.context.close();
});
