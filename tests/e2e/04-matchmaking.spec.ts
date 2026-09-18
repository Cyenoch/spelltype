/**
 * Spec 4 — quick matchmaking: stable tickets, distinct participants, cancellation,
 * difficulty conflicts and expired reservations.
 */
import { expect, test } from '../support/test';
import type { MatchTicket, RoomSnapshot } from '../../shared/protocol';
import { fixture } from '../support/runtime';
import { apiJson, gotoApp, openHome, settle, signedInContext, testId, visibleErrorText, type Session } from '../support/ui';

test.beforeEach(async () => {
  await fixture().reset();
  // No difficulty: the fixture follows the length band stated in the room's own prompt.
  await fixture().scenario({ mode: 'success' });
});

/** Queues or polls the single matchmaking ticket; the endpoint is idempotent per account. */
async function matchTicket(session: Session, difficulty: 'easy' | 'normal' | 'hard' = 'normal') {
  return apiJson<MatchTicket>(session.context, '/api/match', { method: 'POST', data: { difficulty } });
}

async function accountId(session: Session): Promise<string> {
  const sessionInfo = await apiJson<{ user: { id: string } | null }>(session.context, '/api/session');
  return sessionInfo.body.user!.id;
}

test('快速匹配把两个不同账号配进同一房间，重复轮询保持稳定且不会自我匹配', async ({ browser }) => {
  const first = await signedInContext(browser, 'qa');
  const second = await signedInContext(browser, 'qb');

  const waiting = await matchTicket(first);
  expect(waiting.body.state).toBe('waiting');
  expect(typeof waiting.body.difficulty).toBe('string');
  expect(typeof waiting.body.expiresAt).toBe('number');

  // Polling refreshes a waiting entry's lease: the state stays 'waiting' and the expiry
  // only ever moves forward (it is a lease, not a frozen value).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const again = await matchTicket(first);
    expect(again.body.state).toBe('waiting');
    expect(again.body.expiresAt).toBeGreaterThanOrEqual(waiting.body.expiresAt);
    await settle(400);
  }

  const conflict = await apiJson(first.context, '/api/match', { method: 'POST', data: { difficulty: 'hard' } });
  expect(conflict.status).toBe(409);

  // Seeding one account and then enqueueing the partner pairs them; the first account's
  // earlier poll legitimately reported 'waiting', so both are re-polled for the final ticket.
  await matchTicket(second);
  await matchTicket(first);
  const matchedFirst = await matchTicket(first);
  const matchedSecond = await matchTicket(second);
  expect(matchedFirst.body.state).toBe('matched');
  expect(matchedSecond.body.state).toBe('matched');
  expect(matchedFirst.body.roomId).toBe(matchedSecond.body.roomId);
  expect(matchedFirst.body.roomId).toMatch(/^[0-9a-f]{24}$/);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect((await matchTicket(first)).body.roomId).toBe(matchedFirst.body.roomId);
    expect((await matchTicket(second)).body.roomId).toBe(matchedFirst.body.roomId);
  }

  const snapshot = await apiJson<RoomSnapshot>(first.context, `/api/rooms/${matchedFirst.body.roomId}`);
  expect(snapshot.status).toBe(200);
  expect(snapshot.body.players.map((player) => player.id).sort()).toEqual([await accountId(first), await accountId(second)].sort());
  expect(snapshot.body.mode).toBe('quick');
  expect(snapshot.body.spell).toBeNull();
  // Exactly one host, one seat per account, no duplicated roster entry.
  expect(snapshot.body.players).toHaveLength(2);
  expect(new Set(snapshot.body.players.map((player) => player.id)).size).toBe(2);
  expect(snapshot.body.players.filter((player) => player.id === snapshot.body.hostId)).toHaveLength(1);

  const cancelled = await apiJson<{ cancelled: boolean }>(first.context, '/api/match', { method: 'DELETE' });
  expect(cancelled.body.cancelled).toBe(true);
  const afterCancel = await matchTicket(first);
  expect(afterCancel.body.state === 'waiting' || afterCancel.body.roomId !== matchedFirst.body.roomId).toBe(true);
  // Re-polling may have re-queued the account: cancel again so no reservation leaks into the
  // shared difficulty queue (the afterEach cleanup is the safety net, this is the intent).
  expect((await apiJson<{ cancelled: boolean }>(first.context, '/api/match', { method: 'DELETE' })).body.cancelled).toBe(true);
  expect((await apiJson<{ cancelled: boolean }>(second.context, '/api/match', { method: 'DELETE' })).body.cancelled).toBe(true);

  await first.context.close();
  await second.context.close();
});

test('两名玩家经界面配对进入同一房间并自动开局', async ({ browser }) => {
  const first = await signedInContext(browser, 'ui1');
  const second = await signedInContext(browser, 'ui2');
  await openHome(first.page);
  await openHome(second.page);

  await testId(first.page, 'home-quick-difficulty').selectOption('normal');
  await testId(second.page, 'home-quick-difficulty').selectOption('normal');
  await testId(first.page, 'home-quick-start').click();
  await expect(testId(first.page, 'view-queue')).toBeVisible();
  await expect(testId(first.page, 'queue-state')).toHaveAttribute('data-state', 'waiting');

  await testId(second.page, 'home-quick-start').click();
  await expect(testId(second.page, 'view-queue')).toBeVisible();

  // Both players are sent to the same room; a quick room may already be past the lobby by the
  // time both connect, so wait for the room view and read its authoritative room id.
  for (const page of [first.page, second.page]) {
    await expect(testId(page, 'view-room')).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(
        async () => (await testId(page, 'lobby-panel').isVisible()) || (await testId(page, 'battle-panel').isVisible()),
        { timeout: 30_000 },
      )
      .toBe(true);
  }
  const firstRoomId = (await testId(first.page, 'view-room').getAttribute('data-room-id')) ?? '';
  const secondRoomId = (await testId(second.page, 'view-room').getAttribute('data-room-id')) ?? '';
  expect(firstRoomId).toMatch(/^[0-9a-f]{24}$/);
  expect(secondRoomId).toBe(firstRoomId);

  // Both connected → the reserved quick room starts on its own.
  await expect(testId(first.page, 'battle-panel')).toBeVisible({ timeout: 40_000 });
  await expect(testId(second.page, 'battle-panel')).toBeVisible({ timeout: 40_000 });

  // A started match can no longer honestly report a cancellation.
  const cancelled = await apiJson<{ cancelled: boolean }>(first.context, '/api/match', { method: 'DELETE' });
  expect(cancelled.body.cancelled).toBe(false);

  await first.context.close();
  await second.context.close();
});

test('取消等待后状态可见，且不会把取消成功的玩家塞进隐藏房间', async ({ browser }) => {
  const solo = await signedInContext(browser, 'solo');
  await openHome(solo.page);
  await testId(solo.page, 'home-quick-difficulty').selectOption('normal');
  await testId(solo.page, 'home-quick-start').click();
  await expect(testId(solo.page, 'queue-state')).toHaveAttribute('data-state', 'waiting', { timeout: 20_000 });
  await expect(testId(solo.page, 'queue-elapsed')).toBeVisible();

  await testId(solo.page, 'queue-cancel').click();
  await expect(testId(solo.page, 'queue-state')).toHaveAttribute('data-state', 'cancelled', { timeout: 20_000 });
  await expect(testId(solo.page, 'view-room')).toBeHidden();

  await testId(solo.page, 'queue-requeue').click();
  await expect(testId(solo.page, 'queue-state')).toHaveAttribute('data-state', 'waiting', { timeout: 20_000 });
  await testId(solo.page, 'queue-cancel').click();
  await expect(testId(solo.page, 'queue-state')).toHaveAttribute('data-state', 'cancelled', { timeout: 20_000 });

  await solo.context.close();
});

test('取消与连接竞争时不会留下隐藏房间，玩家可以重新排队', async ({ browser }) => {
  const first = await signedInContext(browser, 'race1');
  const second = await signedInContext(browser, 'race2');
  await matchTicket(second);
  await matchTicket(first);
  const matchedFirst = await matchTicket(first);
  const matchedSecond = await matchTicket(second);
  expect(matchedFirst.body.state).toBe('matched');
  expect(matchedSecond.body.state).toBe('matched');
  const roomId = matchedFirst.body.roomId!;
  expect(roomId).toBe(matchedSecond.body.roomId);

  // One participant connects (the match has not started), then the other cancels.
  await gotoApp(first.page, `/?room=${roomId}`);
  await expect(testId(first.page, 'lobby-panel')).toBeVisible({ timeout: 30_000 });
  const cancelled = await apiJson<{ cancelled: boolean }>(second.context, '/api/match', { method: 'DELETE' });
  expect(cancelled.body.cancelled).toBe(true);

  // The released player is not left in a hidden match: the room never starts for them.
  await expect.poll(() => visibleErrorText(first.page), { timeout: 20_000 }).not.toBe('');
  await expect(testId(first.page, 'battle-panel')).toBeHidden();
  const requeued = await matchTicket(first);
  expect(requeued.body.state === 'waiting' || requeued.body.roomId !== roomId).toBe(true);

  await first.context.close();
  await second.context.close();
});

test('并发轮询与第三第四名加入不会产生自我匹配、重复房间或双席位', async ({ browser }) => {
  test.setTimeout(240_000);
  const players = [await signedInContext(browser, 'cc1'), await signedInContext(browser, 'cc2')];
  const joiners = [await signedInContext(browser, 'cc3'), await signedInContext(browser, 'cc4')];
  const everyone = [...players, ...joiners];

  const initial = await matchTicket(players[0]);
  expect(initial.body.state).toBe('waiting');

  // Repeated concurrent polling while alone must never pair the account with itself.
  const soloPolls = await Promise.all([matchTicket(players[0]), matchTicket(players[0]), matchTicket(players[0])]);
  expect(soloPolls.every((response) => response.body.state === 'waiting')).toBe(true);
  expect(soloPolls.every((response) => response.body.expiresAt >= initial.body.expiresAt)).toBe(true);

  // Switching difficulty mid-queue is refused instead of holding two seats.
  const crossDifficulty = await Promise.all([matchTicket(players[0], 'hard'), matchTicket(players[0], 'easy')]);
  expect(crossDifficulty.every((response) => response.status === 409)).toBe(true);

  // Two further accounts join while the queued players keep polling.
  await Promise.all([matchTicket(joiners[0]), matchTicket(joiners[1]), matchTicket(players[1]), matchTicket(players[0])]);
  for (let attempt = 0; attempt < 3; attempt += 1) await Promise.all(everyone.map((session) => matchTicket(session)));

  const rooms = new Map<string, string[]>();
  for (const session of everyone) {
    const ticket = (await matchTicket(session)).body;
    expect(ticket.state).toBe('matched');
    expect(ticket.roomId).toMatch(/^[0-9a-f]{24}$/);
    const ids = rooms.get(ticket.roomId!) ?? [];
    ids.push(await accountId(session));
    rooms.set(ticket.roomId!, ids);
  }

  expect(rooms.size).toBe(2);
  for (const ids of rooms.values()) {
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  }
  expect(new Set([...rooms.values()].flat()).size).toBe(4);

  await Promise.all(everyone.map((session) => session.context.close()));
});

test('准备阶段取消会关闭连接并让双方都能重新排队', async ({ browser }) => {
  test.setTimeout(240_000);
  const first = await signedInContext(browser, 'prep1');
  const second = await signedInContext(browser, 'prep2');
  await matchTicket(second);
  await matchTicket(first);
  const matchedFirst = await matchTicket(first);
  const matchedSecond = await matchTicket(second);
  expect(matchedFirst.body.state).toBe('matched');
  expect(matchedSecond.body.state).toBe('matched');
  expect(matchedSecond.body.roomId).toBe(matchedFirst.body.roomId);
  const roomId = matchedFirst.body.roomId!;

  await gotoApp(first.page, `/?room=${roomId}`);
  await expect(testId(first.page, 'lobby-panel')).toBeVisible({ timeout: 30_000 });

  const cancelled = await apiJson<{ cancelled: boolean }>(second.context, '/api/match', { method: 'DELETE' });
  expect(cancelled.body.cancelled).toBe(true);

  // The preparing player is released instead of being left in a hidden room.
  await expect
    .poll(async () => testId(first.page, 'connection-status').getAttribute('data-state'), { timeout: 20_000 })
    .toMatch(/closed|reconnecting/);
  await expect.poll(() => visibleErrorText(first.page), { timeout: 20_000 }).not.toBe('');
  await expect(testId(first.page, 'battle-panel')).toBeHidden();
  const requeued = await matchTicket(first);
  expect(requeued.body.state === 'waiting' || requeued.body.roomId !== roomId).toBe(true);
  expect((await apiJson<{ cancelled: boolean }>(first.context, '/api/match', { method: 'DELETE' })).body.cancelled).toBe(true);

  await first.context.close();
  await second.context.close();
});

test('对手从未到场的过期分配被释放后可重新匹配', async ({ browser }) => {
  const first = await signedInContext(browser, 'exp1');
  const second = await signedInContext(browser, 'exp2');
  const third = await signedInContext(browser, 'exp3');

  await matchTicket(second);
  await matchTicket(first);
  const matchedFirst = await matchTicket(first);
  const matchedSecond = await matchTicket(second);
  expect(matchedFirst.body.state).toBe('matched');
  expect(matchedSecond.body.state).toBe('matched');
  const staleRoomId = matchedFirst.body.roomId!;
  expect(staleRoomId).toBe(matchedSecond.body.roomId);

  const expiresAt = matchedFirst.body.expiresAt ?? Date.now() + 60_000;
  const waitMs = Math.min(100_000, Math.max(1000, expiresAt - Date.now() + 3000));
  await settle(waitMs);

  await expect
    .poll(
      async () => {
        const ticket = (await matchTicket(first)).body;
        return ticket.state === 'waiting' || ticket.roomId !== staleRoomId ? 'released' : 'held';
      },
      { timeout: 45_000, intervals: [5_000] },
    )
    .toBe('released');

  const thirdTicket = await matchTicket(third);
  const firstAgain = await matchTicket(first);
  if (firstAgain.body.state === 'matched' && thirdTicket.body.state === 'matched') {
    expect(firstAgain.body.roomId).toBe(thirdTicket.body.roomId);
    expect(firstAgain.body.roomId).not.toBe(staleRoomId);
  }

  await first.context.close();
  await second.context.close();
  await third.context.close();
});
