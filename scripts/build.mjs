// 生成打包进应用镜像的标准 dist/ 产物：
//
//   dist/client/            Vite 前端构建产物，托管于 `/`
//   dist/server/index.js    server/index.ts 的 Bun 打包文件（应用入口）
//   dist/server/migrate.js  server/migrate.ts 的 Bun 打包文件（单次迁移入口）
//
// 当环境变量固定 SPELLTYPE_BUILD_ID 时（Dockerfile 以此方式传入 BUILD_ID 构建参数），
// 构建标识即为该值；否则每次调用单独生成。该标识仅供参考：
// 它作为 __SPELLTYPE_BUILD_ID__ 宏编译进代码，并由 /health 和 /api/status 上报，
// 以便运维人员确认容器运行的具体构建版本。它绝不用于路由或鉴权，且不存在发布清单。
//
// 构建失败时不会残留 dist/，因此未构建完成的目录树绝不可能成为部署候选版本。
//
// 使用 Bun 运行时执行：bun scripts/build.mjs

import { randomBytes } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const distDir = join(root, 'dist');
const serverDir = join(distDir, 'server');

const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function runtimeExternals() {
  const pkg = await Bun.file(join(root, 'package.json')).json();
  return Object.keys(pkg.dependencies ?? {});
}

/**
 * 构建可部署的 dist/ 目录树。返回 { buildId }。
 * 任何步骤失败时，会在删除 dist/ 后抛出异常。
 */
export async function build({ log = () => {} } = {}) {
  const pinned = process.env.SPELLTYPE_BUILD_ID?.trim() || undefined;
  if (pinned !== undefined && !BUILD_ID_PATTERN.test(pinned)) {
    throw new Error(`SPELLTYPE_BUILD_ID must match ${BUILD_ID_PATTERN}, got "${pinned}".`);
  }
  const buildId = pinned || `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
  await rm(distDir, { recursive: true, force: true });

  try {
    log(`building frontend (build ${buildId})`);
    const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
    const child = Bun.spawn(
      [process.execPath, vite, 'build', '--outDir', 'dist/client', '--emptyOutDir'],
      {
        cwd: root,
        env: { ...process.env, SPELLTYPE_BUILD_ID: buildId },
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    const frontend = await child.exited;
    if (frontend !== 0) throw new Error(`vite build failed with exit code ${frontend}`);

    log('bundling server entries with Bun.build');
    const serverBundle = await Bun.build({
      entrypoints: [join(root, 'server', 'index.ts'), join(root, 'server', 'migrate.ts')],
      outdir: serverDir,
      target: 'bun',
      format: 'esm',
      splitting: false,
      sourcemap: 'none',
      // 编译后的服务端入口携带由 /health 与 /api/status 上报的构建标识；
      // 部署 CLI 在执行 drain 之前，会通过 `--check` 入口验证候选版本的标识。
      define: { __SPELLTYPE_BUILD_ID__: JSON.stringify(buildId) },
      external: await runtimeExternals(),
    });
    if (!serverBundle.success) {
      for (const entry of serverBundle.logs) log(String(entry));
      throw new Error('Bun.build failed for the server entries');
    }
    // 宿主机侧的维护入口编译为固定输出文件名
    // (dist/server/maintenance.js)，与其源文件名无关。
    const maintenanceBundle = await Bun.build({
      entrypoints: [join(root, 'server', 'maintenance-cli.ts')],
      outdir: serverDir,
      target: 'bun',
      format: 'esm',
      splitting: false,
      sourcemap: 'none',
      define: { __SPELLTYPE_BUILD_ID__: JSON.stringify(buildId) },
      external: await runtimeExternals(),
    });
    if (!maintenanceBundle.success) {
      for (const entry of maintenanceBundle.logs) log(String(entry));
      throw new Error('Bun.build failed for server/maintenance-cli.ts');
    }
    await rename(join(serverDir, 'maintenance-cli.js'), join(serverDir, 'maintenance.js'));

    log(`build ${buildId} ready`);
    return { buildId };
  } catch (error) {
    await rm(distDir, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const { buildId } = await build({ log: console.error });
  console.log(
    JSON.stringify({
      event: 'built',
      buildId,
      client: 'dist/client',
      server: ['dist/server/index.js', 'dist/server/migrate.js', 'dist/server/maintenance.js'],
    }),
  );
}
