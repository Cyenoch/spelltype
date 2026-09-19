/**
 * 多个 worker 共享同一个数据库，因此仅关闭浏览器不足以顺利交接到下一个测试：
 * 断开连接的私人对局仍会阻碍退出，快速对局席位仍会占用队列。
 * 通过测试脚手架的数据库观测成员状态，但仅通过公开的 cancel/leave 接口予以释放。
 * 清理过程绝不直接在数据库中删除或改写状态。
 */
import { and, eq, gt, inArray, or } from 'drizzle-orm';
import { expect, request, type APIRequestContext, type BrowserContext } from '@playwright/test';
import { WS_PROTOCOL, type SessionInfo } from '../../shared/protocol';
import { players, rooms } from '../../server/db';
import { testDb } from './db';
import { runtime } from './runtime';

interface TrackedAccount {
  api: APIRequestContext;
  browser: BrowserContext;
}
const tracked: TrackedAccount[] = [];

/** 即使测试用例关闭了其浏览器上下文，也保留会话 Cookie。 */
export async function trackAccountForQueueCleanup(
  context: BrowserContext,
  baseUrl: string,
): Promise<void> {
  const cookies = await context.cookies(baseUrl);
  if (cookies.length === 0)
    throw new Error(`queue cleanup tracking found no session cookie for ${baseUrl}`);
  const api = await request.newContext({
    storageState: { cookies, origins: [] },
    extraHTTPHeaders: { 'X-Spelltype-Protocol': WS_PROTOCOL },
  });
  tracked.push({ api, browser: context });
}

/** 释放每个账号自有的席位；鉴权失败或服务端拒绝绝不算作清理成功。 */
export async function cleanupTrackedQueues(): Promise<void> {
  const accounts = tracked.splice(0);
  const failures: unknown[] = [];
  try {
    // 取消前停止轮询，否则仍处于打开状态的队列可能立即重新加入。
    for (const browser of new Set(accounts.map((account) => account.browser))) {
      await browser.close();
    }
    const appUrl = runtime().appUrl;
    const activeRoom = or(
      inArray(rooms.phase, ['generating', 'countdown', 'playing']),
      and(eq(rooms.reservation_state, 'reserved'), gt(rooms.reservation_expires_at, Date.now())),
    );
    for (const { api } of accounts) {
      try {
        const session = await api.get(new URL('/api/session', appUrl).href);
        if (session.status() !== 200)
          throw new Error(`account cleanup: GET /api/session returned ${session.status()}`);
        const { user } = (await session.json()) as SessionInfo;
        if (!user) continue; // 已吊销的会话无法继续执行受认证操作。

        const cancel = await api.delete(new URL('/api/match', appUrl).href, {
          headers: { origin: appUrl },
        });
        if (cancel.status() !== 200)
          throw new Error(`account cleanup: DELETE /api/match returned ${cancel.status()}`);
        if (typeof (await cancel.json()).cancelled !== 'boolean')
          throw new Error('account cleanup: cancellation response has no boolean result');

        // 对于已开局的比赛，cancelled:false 是诚实的判定。
        // 通过房间自有的公开离开接口退出真实的成员状态（包括没有匹配票据的私人房间）。
        const memberships = await testDb()
          .select({ id: rooms.id })
          .from(rooms)
          .innerJoin(players, eq(players.room_id, rooms.id))
          .where(and(eq(players.user_id, user.id), activeRoom));
        for (const room of memberships) {
          const left = await api.post(new URL(`/api/rooms/${room.id}/leave`, appUrl).href, {
            headers: { origin: appUrl },
          });
          if (left.status() !== 200)
            throw new Error(`account cleanup: leave ${room.id} returned ${left.status()}`);
        }
      } catch (error) {
        failures.push(error);
      }
    }
    // 战前认输立即持久化，但生成/倒计时阶段需通过运行时已有的状态转换完成结算。
    // 使用测试套件常规的时间上限观测该结算。
    if (failures.length === 0)
      await expect
        .poll(() => testDb().select({ id: rooms.id }).from(rooms).where(activeRoom))
        .toEqual([]);
  } finally {
    const disposed = await Promise.allSettled(accounts.map(({ api }) => api.dispose()));
    for (const result of disposed) if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length) throw new AggregateError(failures, 'Account cleanup failed');
}
