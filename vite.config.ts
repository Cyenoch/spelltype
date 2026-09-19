import { defineConfig } from 'vite';
import { frontendPlugins } from './vite.frontend.ts';

// 客户端始终由唯一的应用服务器从根路径（`/`）提供；不存在按版本划分的基准路径。
// SPELLTYPE_BUILD_ID 仅用于向浏览器构建中的信息性宏 __SPELLTYPE_BUILD_ID__ 传值；
// 运行时的构建标识来自 /api/status。
export default defineConfig({
  base: '/',
  define: {
    __SPELLTYPE_BUILD_ID__: JSON.stringify(process.env.SPELLTYPE_BUILD_ID ?? 'development'),
  },
  plugins: frontendPlugins(),
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // 持久化状态与测试证据不得触发现正在进行对局的浏览器重载。
    watch: { ignored: ['**/tests/.state/**', '**/.scratch/**', '**/.data/**'] },
  },
});
