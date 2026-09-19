/**
 * 快速匹配：票据配对的两名玩家、可见的取消操作，以及对手从未加入时预约席位的释放。
 *
 * 排队队列由所有账号共享，因此此处的每个测试场景都会取消其已排队的请求（测试套件的自动夹具是失败测试的兜底保障）。
 * 队列自有的租约规则通过客户端所调用的 API 进行断言。
 */
import { expect, type Browser } from '@playwright/test';
import { test } from '../support/test';
import { INITIAL_HEALTH, type MatchTicket, type Profile } from '../../shared/protocol';
import { fixture } from '../support/runtime';
import { apiJson, gameJson, selfIdentity } from '../support/api';
import { battlePhase, roomSnapshot, snapshotPlayer } from '../support/combat';
import { gotoApp, openHome, settle, visibleErrorText } from '../support/app';
import { signedInContext, type Session } from '../support/session';

test.beforeEach(async () => {
  await fixture().reset();
});

/** 排队或轮询单张匹配票据；该端点按账号保持幂等。 */
async function matchTicket(session: Session) {
  return gameJson<MatchTicket>(session.context, '/match', { method: 'POST' });
}

/** 页面调用的准确房间路由；拦截规则绝不能误伤其他路径。 */
const ROOM_READ = /\/api\/rooms\/[0-9a-f]{24}$/;
const ROOM_LEAVE = /\/api\/rooms\/[0-9a-f]{24}\/leave$/;

test('两名玩家经界面配对进入同一房间并自动开局', async ({ browser }) => {
  const first = await signedInContext(browser, 'ui1');
  const second = await signedInContext(browser, 'ui2');
  await openHome(first.page);
  await openHome(second.page);
  await fixture().setDelay(6000);

  await first.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('view-queue')).toBeVisible();
  await expect(first.page.getByTestId('queue-state')).toHaveAttribute('data-state', 'waiting');

  // 缓慢的房间读取必须保持匹配完成的队列可见，直到房间准入完成：
  // 用户必须持续看到队列界面，而不是加载中的替代占位。
  await expect(first.page.getByTestId('queue-stage')).toBeVisible();
  await expect(first.page.getByTestId('queue-panel')).toBeVisible();
  const roomRequested = Promise.withResolvers<void>();
  const releaseRoom = Promise.withResolvers<void>();
  await first.page.route(ROOM_READ, async (route) => {
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
    // StyleX 延迟规则可能在请求期间结算；页面总高度并非契约内容。
    await expect(first.page.getByTestId('queue-stage')).toBeVisible();
    await expect(first.page.getByTestId('queue-panel')).toBeVisible();
  } finally {
    releaseRoom.resolve();
  }

  // 双方玩家均被送往同一房间；在双方都连接时快速房间可能已经越过了大厅，
  // 因此等待房间视图并读取其权威房间 ID。生成阶段现在是独立界面：大厅、战斗或生成均算作已到达。
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

  // 双方已连接 → 预留的快速房间自行开始。预热的预设法术书几乎瞬间越过生成界面，
  // 因此通过 playing 阶段（以及隐藏的生成界面）证明已到达，而非在中途捕捉该界面。
  for (const page of [first.page, second.page]) {
    await expect(page.getByTestId('battle-panel')).toHaveAttribute('data-phase', 'playing', {
      timeout: 40_000,
    });
    await expect(page.getByTestId('spell-generation')).toBeHidden();
    await expect(page.getByTestId('typing-input')).toBeVisible();
  }

  // 已开始的比赛无法再如实汇报取消操作。
  const cancelled = await gameJson<{ cancelled: boolean }>(first.context, '/match', {
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

  // 单独排队随后取消：状态清晰可见，不创建隐藏房间，且玩家可以重新排队。
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

  // 在入队延迟期间离开绝不能遗留可被对手匹配的孤儿票据。
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
    (response) => response.url().endsWith('/match') && response.request().method() === 'DELETE',
  );
  await first.page.getByTestId('queue-home').click();
  await Promise.race([cancelled, settle(500)]);
  release.resolve();
  await cancelled;
  await first.page.unroute('**/api/match');
  expect((await matchTicket(second)).body.state).toBe('waiting');
  await gameJson(second.context, '/match', { method: 'DELETE' });

  // 当本玩家已进入就绪的大厅时对手取消：已连接的玩家必须被释放而非留在隐藏房间中，并可以重新排队。
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
    (await gameJson<{ cancelled: boolean }>(second.context, '/match', { method: 'DELETE' })).body
      .cancelled,
  ).toBe(true);

  await expect
    .poll(async () => first.page.getByTestId('connection-status').getAttribute('data-state'), {
      timeout: 20_000,
    })
    .toMatch(/closed|reconnecting/);
  await expect.poll(() => visibleErrorText(first.page), { timeout: 20_000 }).not.toBe('');
  await expect(first.page.getByTestId('battle-panel')).toBeHidden();
  // 另一个席位因取消而被删除：当针对性的离开接口回复席位已不存在时，通知提示仍必须允许本玩家恢复。
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

  // 快照失败绝不能将预留席位变成无限重入房间的死循环。
  await first.page.route(`**/api/rooms/${roomId}`, (route) =>
    route.fulfill({ status: 500, json: { error: '房间暂时不可用' } }),
  );
  await first.page.getByTestId('home-quick-start').click();
  await expect(first.page.getByTestId('room-error')).toBeVisible();
  await expect(first.page.getByTestId('connection-status')).toHaveAttribute('data-state', 'closed');

  // 清理失败不等于成功退出；在服务端确认之前，重试保持同一预约，即使初始快照缺失也是如此。
  const leaveUrl = `**/api/rooms/${roomId}/leave`;
  await first.page.route(leaveUrl, (route) => route.abort('connectionfailed'));
  await first.page.getByTestId('room-error-home').click();
  await expect(first.page.locator('[data-testid="toast"] > [data-tone="error"]')).toBeVisible();
  await expect(first.page.getByTestId('room-error-home')).toBeEnabled();
  await expect(first.page.getByTestId('view-home')).toBeHidden();
  expect((await matchTicket(first)).body.roomId).toBe(roomId);
  await first.page.unroute(leaveUrl);

  // 被拒绝的离场（运行时无法证明席位状态）同样不属于离开：页面保持原状，保留预约并提供重试。
  await first.page.route(leaveUrl, (route) =>
    route.fulfill({
      status: 503,
      json: { code: 'maintenance:unavailable', error: '服务状态暂不可用，请稍后重试。' },
    }),
  );
  await first.page.getByTestId('room-error-home').click();
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
    (response) => response.url().endsWith('/match') && response.request().method() === 'POST',
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

  // 被替换窗口的返回主页仅作用于本地：它绝不能取消同账号新窗口当前控制的房间。
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

  // 轮询会刷新等待条目的租约：状态保持为 'waiting' 且过期时间仅会向前推移（它是租约，而非冻结值）。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    expect((await matchTicket(first)).body.expiresAt).toBeGreaterThanOrEqual(
      waiting.body.expiresAt,
    );
    await settle(300);
  }

  // 独自排队时重复轮询绝不会将账号与自身配对。
  const alone = await Promise.all([matchTicket(first), matchTicket(first), matchTicket(first)]);
  expect(alone.every((response) => response.body.state === 'waiting')).toBe(true);

  // 先为一个账号注入排队，然后入队其搭档即可完成配对。
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

  // 取消有效预约会被如实汇报，且被释放的玩家可以重新排队。
  expect(
    (await gameJson<{ cancelled: boolean }>(first.context, '/match', { method: 'DELETE' })).body
      .cancelled,
  ).toBe(true);
  const requeued = await matchTicket(first);
  expect(
    requeued.body.state === 'waiting' || requeued.body.roomId !== matchedFirst.body.roomId,
  ).toBe(true);
  // 重新轮询可能已经让账号重新排队：再次取消以避免预约泄露到共享队列中（afterEach 清理是安全兜底，这是主观意图）。
  expect(
    (await gameJson<{ cancelled: boolean }>(first.context, '/match', { method: 'DELETE' })).body
      .cancelled,
  ).toBe(true);
  expect(
    (await gameJson<{ cancelled: boolean }>(second.context, '/match', { method: 'DELETE' })).body
      .cancelled,
  ).toBe(true);

  await first.context.close();
  await second.context.close();
});

/** 通过 API 为两名玩家快速配对，随后通过 UI 为双方开启真实对局。 */
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

  // 离开请求被拦截在网络层：在服务端切实提交离场之前，任何逻辑都不能谎报成功、离开页面或重新排队。
  let leaveRequests = 0;
  const leaveArrived = Promise.withResolvers<void>();
  const releaseLeave = Promise.withResolvers<void>();
  await leaver.page.route(ROOM_LEAVE, async (route) => {
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

  // 重复点击会共享正在进行的单个请求，而不是重复发起。
  await leaver.page.getByTestId('battle-leave').click();
  await settle(300);
  expect(leaveRequests).toBe(1);

  releaseLeave.resolve();
  await expect(leaver.page.getByTestId('view-home')).toBeVisible({ timeout: 20_000 });
  await expect(leaver.page.getByTestId('view-room')).toBeHidden();

  // 弃赛对决为离场者持久化记录：退出比赛、名次排在幸存者之后，并生成一条持久化的结算记录行。
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

  // 幸存房间保留其结算结果，离场者被标记为已淘汰。
  await expect
    .poll(async () => (await roomSnapshot(keeper.context, roomId)).phase, { timeout: 30_000 })
    .toBe('finished');
  const settled = await roomSnapshot(keeper.context, roomId);
  expect(settled.endReason).toBe('elimination');
  const leaverSeat = snapshotPlayer(settled, leaverIdentity);
  expect(leaverSeat.hp).toBe(0);
  expect(leaverSeat.eliminatedAt).not.toBeNull();
  expect(leaverSeat.rank).toBe(2);

  // 重新排队将回归的玩家匹配到一个全新的房间，绝不会是那个已放弃的旧房间。
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

  // 请求从未到达服务端：汇报失败，不宣称任何成功，也不提交任何变更。
  await leaver.page.route(ROOM_LEAVE, (route) => route.abort('connectionfailed'));
  await leaver.page.getByTestId('battle-leave').click();
  await expect(leaver.page.locator('[data-testid="toast"] > [data-tone="error"]')).toBeVisible();
  await expect(leaver.page.getByTestId('view-room')).toBeVisible();
  expect(await battlePhase(leaver.page)).toBe('playing');

  // 席位保持原样：没有静默弃赛判负，比赛直接继续。
  const untouched = await roomSnapshot(keeper.context, roomId);
  expect(untouched.phase).toBe('playing');
  expect(snapshotPlayer(untouched, leaverIdentity).eliminatedAt).toBeNull();
  expect(snapshotPlayer(untouched, leaverIdentity).hp).toBe(INITIAL_HEALTH);

  // 相同的按钮在网络恢复后重试并顺利完成离场。
  await leaver.page.unroute(ROOM_LEAVE);
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
  await leaver.page.route(ROOM_LEAVE, async (route) => {
    const response = await route.fetch();
    committedStatus = response.status();
    await route.abort('connectionfailed');
  });

  await leaver.page.getByTestId('battle-leave').click();
  await expect(
    leaver.page.locator('[data-testid="toast"] > [data-tone="error"]').first(),
  ).toBeVisible();
  expect(committedStatus).toBe(200);
  await expect(leaver.page.getByTestId('view-home')).toBeHidden();
  expect((await roomSnapshot(keeper.context, roomId)).phase).toBe('finished');

  await leaver.page.unroute(ROOM_LEAVE);
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
