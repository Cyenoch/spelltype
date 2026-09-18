/**
 * Quick matchmaking: the two players a ticket pairs, the visible cancellation, and the release of a
 * reservation that the opponent never joined.
 *
 * Matchmaking is global per difficulty, so every scenario here cancels what it queued (and the
 * suite's auto fixture is the net for a failing test). The queue's own lease/conflict rules are
 * asserted through the API the client calls.
 */
import { expect } from '@playwright/test';
import { test } from '../support/test';
import type { MatchTicket, RoomSnapshot } from '../../shared/protocol';
import { fixture } from '../support/runtime';
import { apiJson } from '../support/api';
import { gotoApp, openHome, settle, visibleErrorText } from '../support/app';
import { signedInContext, type Session } from '../support/session';

test.beforeEach(async () => {
  await fixture().reset();
});

/** Queues or polls the single matchmaking ticket; the endpoint is idempotent per account. */
async function matchTicket(session: Session, difficulty: 'easy' | 'normal' | 'hard' = 'normal') {
  return apiJson<MatchTicket>(session.context, '/api/match', {
    method: 'POST',
    data: { difficulty },
  });
}

test('两名玩家经界面配对进入同一房间并自动开局', async ({ browser }) => {
  const first = await signedInContext(browser, 'ui1');
  const second = await signedInContext(browser, 'ui2');
  await openHome(first.page);
  await openHome(second.page);

  await first.page.getByTestId('home-quick-difficulty').selectOption('normal');
  await second.page.getByTestId('home-quick-difficulty').selectOption('normal');
  await first.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('view-queue')).toBeVisible();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting');

  await second.page.getByTestId('home-quick-start').click();

  // Both players are sent to the same room; a quick room may already be past the lobby by the
  // time both connect, so wait for the room view and read its authoritative room id.
  for (const page of [first.page, second.page]) {
    await expect(page.getByTestId('view-room')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () =>
          (await page.getByTestId('lobby-panel').isVisible()) ||
          (await page.getByTestId('battle-panel').isVisible()),
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

  // Both connected → the reserved quick room starts on its own.
  await expect(first.page.getByTestId('battle-panel')).toBeVisible({ timeout: 40_000 });
  await expect(second.page.getByTestId('battle-panel')).toBeVisible({ timeout: 40_000 });

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
  await first.page.getByTestId('home-quick-difficulty').selectOption('normal');
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
  const requeued = await matchTicket(first);
  expect(requeued.body.state === 'waiting' || requeued.body.roomId !== roomId).toBe(true);
  expect(
    (await apiJson<{ cancelled: boolean }>(first.context, '/api/match', { method: 'DELETE' })).body
      .cancelled,
  ).toBe(true);

  await first.context.close();
  await second.context.close();
});

test('排队租约只前移，更换难度被拒，并发轮询不会自我匹配', async ({ browser }) => {
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

  // Switching difficulty mid-queue is refused instead of holding two seats.
  expect((await matchTicket(first, 'hard')).status).toBe(409);
  expect((await matchTicket(first, 'easy')).status).toBe(409);

  // Seeding one account and then enqueueing the partner pairs them.
  await matchTicket(second);
  const matchedFirst = await matchTicket(first);
  const matchedSecond = await matchTicket(second);
  expect(matchedFirst.body.state).toBe('matched');
  expect(matchedSecond.body.state).toBe('matched');
  expect(matchedFirst.body.roomId).toMatch(/^[0-9a-f]{24}$/);
  expect(matchedSecond.body.roomId).toBe(matchedFirst.body.roomId);

  const snapshot = await apiJson<RoomSnapshot>(
    first.context,
    `/api/rooms/${matchedFirst.body.roomId}`,
  );
  expect(snapshot.status).toBe(200);
  expect(snapshot.body.mode).toBe('quick');
  expect(snapshot.body.players).toHaveLength(2);
  expect(new Set(snapshot.body.players.map((player) => player.id)).size).toBe(2);
  expect(snapshot.body.players.filter((player) => player.id === snapshot.body.hostId)).toHaveLength(
    1,
  );

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
  // shared difficulty queue (the afterEach cleanup is the safety net, this is the intent).
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
