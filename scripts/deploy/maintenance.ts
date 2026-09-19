// 宿主机端维护运行器。负责在运行中的应用容器内执行单次维护入口
// (`docker compose exec -T app bun dist/server/maintenance.js ...`)；
// 或在应用容器尚不存在时，通过相同的固定镜像以单次容器方式运行
// (`docker compose run -T --rm --no-deps --entrypoint bun app dist/server/maintenance.js ...`)。
// 宿主机的 Docker 权限是唯一的鉴权方式：应用中没有管理监听端口，
// 没有 Bearer 令牌，也没有挂载 Docker socket。
// 输出内容均通过共享的维护模式 Schema 进行校验。

import { z } from 'zod';
import {
  drainStatusSchema,
  maintenanceInfoSchema,
  type DrainStatus,
  type MaintenanceInfo,
} from '../../shared/maintenance';
import { compose, type SpawnRun } from './compose';
import type { DeployContext } from './env';
import { MaintenanceConflictError } from './ops';

const MAINTENANCE_EXIT_CONFLICT = 3;

export { MaintenanceConflictError };

/** 校验 `dist/server/maintenance.js --check` 输出的编译后版本标识。 */
export const maintenanceCheckSchema = z.object({
  entry: z.literal('maintenance'),
  buildId: z.string().min(1),
});

async function runMaintenance(
  ctx: DeployContext,
  mode: { via: 'exec' } | { via: 'run'; imageId: string },
  args: string[],
): Promise<SpawnRun> {
  const commandArgs =
    mode.via === 'exec'
      ? ['exec', '-T', 'app', 'bun', 'dist/server/maintenance.js', ...args]
      : [
          'run',
          '-T',
          '--rm',
          '--no-deps',
          '--entrypoint',
          'bun',
          'app',
          'dist/server/maintenance.js',
          ...args,
        ];
  const run = await compose(ctx, commandArgs, mode.via === 'run' ? { imageId: mode.imageId } : {});
  if (run.exitCode === MAINTENANCE_EXIT_CONFLICT) {
    throw new MaintenanceConflictError(
      `maintenance CAS conflict (revision moved underneath the runner): ${run.stderr.trim() || run.stdout.trim()}`,
    );
  }
  if (run.exitCode !== 0) {
    throw new Error(
      `dist/server/maintenance.js ${args.join(' ')} failed (exit ${run.exitCode}): ${run.stderr.trim() || run.stdout.trim()}`,
    );
  }
  return run;
}

/** 从运行中的应用容器读取只读的 DrainStatus。 */
export async function inspectRunning(ctx: DeployContext): Promise<DrainStatus> {
  const run = await runMaintenance(ctx, { via: 'exec' }, ['--status']);
  return drainStatusSchema.parse(JSON.parse(run.stdout));
}

/** 在没有应用运行时，从单次容器读取只读的 DrainStatus。 */
export async function inspectOneShot(ctx: DeployContext, imageId: string): Promise<DrainStatus> {
  const run = await runMaintenance(ctx, { via: 'run', imageId }, ['--status']);
  return drainStatusSchema.parse(JSON.parse(run.stdout));
}

/** 在应用容器内，通过带有版本号（revision）CAS 的操作进入持久化 draining 状态。 */
export async function drainAdmission(
  ctx: DeployContext,
  expectedRevision: number,
): Promise<MaintenanceInfo> {
  const run = await runMaintenance(ctx, { via: 'exec' }, [
    '--drain',
    '--expected-revision',
    String(expectedRevision),
  ]);
  return maintenanceInfoSchema.parse(JSON.parse(run.stdout));
}

/**
 * 通过完整的 CAS 机制重新开放准入：需要预期的版本号（revision）以及
 * 运行器刚刚通过公开 /health 接口验证的运行时纪元（runtime epoch，活跃运行时租约凭据）。
 */
export async function resumeAdmission(
  ctx: DeployContext,
  expectedRevision: number,
  expectedRuntimeEpoch: number,
): Promise<MaintenanceInfo> {
  const run = await runMaintenance(ctx, { via: 'exec' }, [
    '--resume',
    '--expected-revision',
    String(expectedRevision),
    '--expected-runtime-epoch',
    String(expectedRuntimeEpoch),
  ]);
  return maintenanceInfoSchema.parse(JSON.parse(run.stdout));
}

export interface DrainWaitOptions {
  timeoutS: number;
  /** 进入维护状态时返回的版本号；绝不隐式接受更新的 drain 状态。 */
  expectedRevision?: number;
  /** 轮询间隔；测试中会缩短此值。 */
  intervalMs?: number;
}

/**
 * 针对正在进行的 drain 排空流程的纯观察器（支持两种通信方式）：
 * 仅当排空就绪且在等待期间 draining 版本号从未改变时才返回状态。
 * 不执行任何修改操作，也绝不强杀任何任务；若维护行处于 open 状态、
 * 版本号发生变动或超时，均会在保留计数指标的情况下抛出异常。
 */
export async function waitForDrainReady(
  load: () => Promise<DrainStatus>,
  options: DrainWaitOptions,
): Promise<DrainStatus> {
  const intervalMs = options.intervalMs ?? 2_000;
  const deadline = Date.now() + options.timeoutS * 1000;
  let baseline: DrainStatus | null = null;
  for (;;) {
    const status = await load();
    if (status.mode !== 'draining') {
      throw new Error(
        `maintenance is ${status.mode}; wait only observes an ongoing drain (drain first, then wait)`,
      );
    }
    if (options.expectedRevision !== undefined && status.revision !== options.expectedRevision) {
      throw new Error(
        `maintenance revision moved ${options.expectedRevision} -> ${status.revision} before waiting; refusing to report ready`,
      );
    }
    if (baseline === null) baseline = status;
    if (status.revision !== baseline.revision) {
      throw new Error(
        `maintenance revision moved ${baseline.revision} -> ${status.revision} while waiting; someone mutated maintenance — refusing to report ready`,
      );
    }
    if (status.ready) return status;
    if (Date.now() > deadline) {
      throw new Error(
        `drain not ready within ${options.timeoutS}s (active matches ${status.activeMatches}, reservations ${status.liveReservations}, pending results ${status.pendingResults}). Nothing was mutated and no game was killed; keep waiting or resume with: bun run maintenance resume`,
      );
    }
    await Bun.sleep(intervalMs);
  }
}
