// docker compose 驱动模块。每次调用均严格限定于已解析的项目名称、
// 解析出的 COMPOSE_FILE 集合以及 deploy/compose.env，
// 确保 CLI 与运维人员始终操作完全相同的技术栈——包括诸如
// deploy/compose.dokploy.yaml 路由等覆盖层。部署级别的覆盖项（固定的镜像 ID）
// 通过进程环境变量注入，compose 变量插值会优先使用进程环境变量而非 env 文件。

import { z } from 'zod';
import type { DeployContext } from './env';

const log = console.error;

const candidateCheckSchema = z.object({
  entry: z.enum(['migrate', 'maintenance']),
  buildId: z.string().min(1),
});

export interface ComposeRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpawnRun extends ComposeRun {
  command: string[];
}

async function spawnCaptured(
  command: string[],
  env?: Record<string, string | undefined>,
): Promise<SpawnRun> {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: env ?? process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { command, exitCode: await child.exited, stdout, stderr };
}

function composeBaseArgs(ctx: DeployContext): string[] {
  const args = ['compose', '--project-name', ctx.project];
  for (const file of ctx.composeFiles) args.push('--file', file);
  args.push('--env-file', ctx.repoEnvFile);
  return args;
}

/** 使用 CLI 规范的项目/文件/环境变量参数执行 docker compose。 */
export async function compose(
  ctx: DeployContext,
  args: string[],
  options: { imageId?: string } = {},
): Promise<SpawnRun> {
  return runCompose(ctx, args, options.imageId, { capture: true });
}

/**
 * 每个 docker compose 命令都会插值整个文件模型，因此
 * 即使对于从不创建 app/migrate 容器的命令（如 ps、stop、inspect），
 * 也必须始终设置 SPELLTYPE_APP_IMAGE。而真正创建容器的命令
 * 则始终显式接收真实的固定 imageId。
 */
function childComposeEnv(imageId: string | undefined): Record<string, string | undefined> {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  // 移除 COMPOSE_FILE：解析出的文件集合作为显式的 --file 参数传入，
  // 两者绝不能产生分歧。
  delete childEnv.COMPOSE_FILE;
  childEnv.SPELLTYPE_APP_IMAGE =
    imageId ?? process.env.SPELLTYPE_APP_IMAGE ?? '_SPELLTYPE_APP_IMAGE_NOT_SET_';
  return childEnv;
}

async function runCompose(
  ctx: DeployContext,
  args: string[],
  imageId: string | undefined,
  options: { capture: boolean },
): Promise<SpawnRun> {
  const command = ['docker', ...composeBaseArgs(ctx), ...args];
  const env = childComposeEnv(imageId);
  if (options.capture) return spawnCaptured(command, env);
  const child = Bun.spawn(command, {
    env,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed with exit code ${exitCode}`);
  }
  return { command, exitCode, stdout: '', stderr: '' };
}

/** 执行 docker compose，继承标准输入输出（显示执行进度），失败时抛出异常。 */
async function composeInherit(ctx: DeployContext, args: string[], imageId?: string): Promise<void> {
  await runCompose(ctx, args, imageId, { capture: false });
}

/** 将镜像引用解析为其确切不可变的 ID。 */
export async function resolveImageId(reference: string): Promise<string> {
  const run = await spawnCaptured(['docker', 'image', 'inspect', reference, '--format', '{{.Id}}']);
  const id = run.stdout.trim();
  if (run.exitCode !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id)) {
    throw new Error(
      `Cannot resolve "${reference}" to a local image ID${run.stderr.trim() ? `: ${run.stderr.trim()}` : ''}. Pull or build it first.`,
    );
  }
  return id;
}

/**
 * 验证候选镜像中的两个服务端入口均可正常执行，并读取编译后的构建标识。
 * 该操作在进入任何维护状态前执行，以确保有缺陷的候选版本绝不会导致服务关闭。
 * 两个入口的构建标识必须一致：同一个镜像，同一次构建。
 */
export async function checkCandidate(imageId: string): Promise<{ buildId: string }> {
  const checks = await Promise.all(
    (['dist/server/migrate.js', 'dist/server/maintenance.js'] as const).map(async (entry) => {
      const run = await spawnCaptured(['docker', 'run', '--rm', imageId, 'bun', entry, '--check']);
      if (run.exitCode !== 0) {
        throw new Error(
          `Candidate image failed its executable check for ${entry}${run.stderr.trim() ? `: ${run.stderr.trim()}` : ''}`,
        );
      }
      try {
        return candidateCheckSchema.parse(JSON.parse(run.stdout));
      } catch (error) {
        throw new Error(
          `Candidate ${entry} --check output was not the expected identity JSON (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }),
  );
  const [migrate, maintenance] = checks;
  if (migrate.buildId !== maintenance.buildId) {
    throw new Error(
      `Candidate identity mismatch between entries: migrate ${migrate.buildId}, maintenance ${maintenance.buildId}`,
    );
  }
  return { buildId: migrate.buildId };
}

/** 检查失败或结果歧义时直接拒绝，而非误判为应用不存在。 */
export async function inspectRunningApp(
  ctx: DeployContext,
): Promise<{ containerId: string; imageId: string } | null> {
  const run = await compose(ctx, ['ps', '--quiet', 'app']);
  if (run.exitCode !== 0) throw new Error(`Cannot inspect app containers: ${run.stderr.trim()}`);
  const ids = run.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length === 0) return null;
  if (ids.length !== 1)
    throw new Error('Expected exactly one running app container; refusing deployment.');
  const image = await spawnCaptured(['docker', 'inspect', ids[0], '--format', '{{.Image}}']);
  const imageId = image.stdout.trim();
  if (image.exitCode !== 0 || !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw new Error('Cannot prove the running application image; refusing deployment.');
  }
  return { containerId: ids[0], imageId };
}

export async function stopApp(ctx: DeployContext): Promise<void> {
  log('stopping the old app container');
  await composeInherit(ctx, ['stop', 'app']);
}

/** 重新创建应用容器，固定为确切的镜像 ID，无依赖项启动。 */
export async function startApp(ctx: DeployContext, imageId: string): Promise<void> {
  log(`starting app at ${imageId}`);
  await composeInherit(ctx, ['up', '-d', '--no-deps', '--force-recreate', 'app'], imageId);
  const running = await inspectRunningApp(ctx);
  if (running?.imageId !== imageId) {
    throw new Error(
      'The running container does not match the pinned candidate image; refusing to resume.',
    );
  }
}

/** 确保数据库服务处于运行状态且通过健康检查。 */
export async function ensureDatabase(ctx: DeployContext): Promise<void> {
  log('ensuring the database is up');
  await composeInherit(ctx, ['up', '-d', '--wait', '--wait-timeout', '120', 'database']);
}

/**
 * 使用指定的候选镜像运行单次前向数据库迁移。
 * 绝不与应用容器并发运行；调用方负责保证其执行顺序。
 */
export async function runMigrate(ctx: DeployContext, imageId: string): Promise<void> {
  log('applying the one-shot forward migration');
  await composeInherit(ctx, ['run', '--rm', 'migrate'], imageId);
}

/** 根据代码仓库检出构建候选镜像。 */
export async function buildImage(repoRoot: string, tag: string, buildId: string): Promise<void> {
  const child = Bun.spawn(
    ['docker', 'build', '--build-arg', `BUILD_ID=${buildId}`, '--tag', tag, repoRoot],
    { stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`docker build failed with exit code ${exitCode}`);
  }
}
