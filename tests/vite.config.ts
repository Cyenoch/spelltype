/**
 * 仅供 E2E 测试环境的 UI 服务端使用的 Vite 配置
 * （`tests/support/harness.ts` 通过 Vite 的 JS API 启动唯一实例）。
 *
 * 本文件只承载共享的产品构建管线（路由、JSX + StyleX ——
 * 与产品构建所用完全相同的管线，因此被测浏览器渲染的正是实际交付的内容）。
 * 所有与实例相关的内容都由测试环境在每次启动时内联注入：
 *  - 依赖优化器的 `cacheDir`，按 worker 隔离，使该实例绝不会删除另一个产出方已提交的缓存；
 *  - 指向应用服务端的 `/api` 代理（UI 源就是配置的公开源）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { frontendPlugins } from '../vite.frontend.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  root,
  plugins: [...frontendPlugins()],
  // 被测浏览器会选择启用真实的 Service Worker：`src/app/notifications.ts`
  // 以 `import.meta.env.PROD || VITE_ENABLE_NOTIFICATIONS_SW === '1'` 作为注册门槛，
  // 而开发服务器默认必须不带 SW，因此 E2E UI 在此设置该标记。
  // 每次启动时会与测试环境内联的按版本 `define`（release id）合并。
  define: { 'import.meta.env.VITE_ENABLE_NOTIFICATIONS_SW': '"1"' },
  optimizeDeps: { holdUntilCrawlEnd: false },
  logLevel: 'info',
});
