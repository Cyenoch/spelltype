/**
 * 本测试套件使用的 Playwright test 对象。
 *
 * 原生测试环境在本 worker 进程首次使用时惰性启动，并在 worker 销毁时停止：fixture、微信
 * bridge、PGlite 数据库、应用服务器（同一监听器上的稳定 API + 游戏与管理员路径）和 UI 都
 * 运行在这里，因此各 spec 直接共享服务端的 Drizzle 实例。
 *
 * 自动 fixture 还保证每个被跟踪的账号在每条测试之后干净交接：排队预留被取消，而对局 —— 它
 * 真实地拒绝取消 —— 通过房间自己的公开离开端点退出，于是排队账号或被遗弃的进行中对局都不
 * 会泄漏到本 worker 的下一条测试。
 */
import { test as base } from '@playwright/test';
import { cleanupTrackedQueues } from './accounts';
import { startHarness, type Harness } from './harness';

export const test = base.extend<{ queueCleanup: void }, { harness: Harness }>({
  harness: [
    async ({}, use) => {
      // 测试环境持有进程的 PGlite 声明和所有监听中的服务器：如果 worker 未经干净停止就消失，
      // 数据库声明会比它活得更久，每个接替的 worker 都会拒绝启动。因此即使 worker 正在展开
      // 栈，stop() 也要执行。
      const instance = await startHarness();
      try {
        await use(instance);
      } finally {
        await instance.stop();
      }
    },
    { scope: 'worker', auto: true },
  ],
  queueCleanup: [
    async ({}, use) => {
      await use();
      await cleanupTrackedQueues();
    },
    { auto: true },
  ],
});
