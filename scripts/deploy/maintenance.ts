// Host-side maintenance runner. Drives the one-shot maintenance entry inside
// the running app container (`docker compose exec -T app bun
// dist/server/maintenance.js ...`) or, while no app container exists, as a
// one-shot container from the same pinned image (`docker compose run -T --rm
// --no-deps --entrypoint bun app dist/server/maintenance.js ...`). The
// host's Docker privilege is the only authorization: no admin listener, no
// bearer token, no Docker socket in the app. Outputs are validated with the
// shared maintenance schemas.

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

/** Validates the compiled identity output of `dist/server/maintenance.js --check`. */
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

/** Read-only DrainStatus from the running app container. */
export async function inspectRunning(ctx: DeployContext): Promise<DrainStatus> {
  const run = await runMaintenance(ctx, { via: 'exec' }, ['--status']);
  return drainStatusSchema.parse(JSON.parse(run.stdout));
}

/** Read-only DrainStatus from a one-shot container while no app is running. */
export async function inspectOneShot(ctx: DeployContext, imageId: string): Promise<DrainStatus> {
  const run = await runMaintenance(ctx, { via: 'run', imageId }, ['--status']);
  return drainStatusSchema.parse(JSON.parse(run.stdout));
}

/** Enters durable draining with the revision CAS, inside the app container. */
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
 * Reopens admission with the full CAS: expected revision AND the runtime
 * epoch the runner just proved against public /health (live runtime lease).
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
  /** The revision returned by entering maintenance; never adopt a newer drain implicitly. */
  expectedRevision?: number;
  /** Poll interval; tests shrink it. */
  intervalMs?: number;
}

/**
 * Pure observer over an ongoing drain (either transport): returns the status
 * only when the drain is ready AND the draining revision never moved during
 * the wait. Performs no mutations and kills nothing; an open maintenance row,
 * a moved revision or a timeout all throw with the counts intact.
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
