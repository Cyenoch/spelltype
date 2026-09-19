// Deployment flows: build, secrets, install (bootstrap), deploy, rollback,
// maintenance operations and status. Every flow treats durable maintenance as
// the single source of truth: admission is closed (draining) before any
// container stops, timeouts abort without killing games, a failed update
// stays closed, and resuming always goes through the revision + runtime-epoch
// CAS with the epoch proven against public /health immediately before. The
// exact previous image ID is recorded locally so rollback restores precisely
// what ran before — it never down-migrates the schema.

import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { getRuntimeHealth, getServiceStatus } from './probe';
import {
  drainAdmission,
  inspectOneShot,
  inspectRunning,
  resumeAdmission,
  waitForDrainReady,
} from './maintenance';
import { opsDrain, opsDrainStatus, opsResume } from './ops';
import {
  inspectRunningApp,
  buildImage,
  checkCandidate,
  compose,
  ensureDatabase,
  resolveImageId,
  runMigrate,
  startApp,
  stopApp,
} from './compose';
import {
  createSecretFile,
  loadContext,
  loadOpsClient,
  repoRoot,
  requireAllSecrets,
  secretFile,
  type DeployContext,
} from './env';
import { acquireLock, clearStaleLock } from './lock';

const log = console.error;

const DEFAULT_DRAIN_TIMEOUT_S = 600;
const APP_START_TIMEOUT_MS = 180_000;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;

const imageRecordSchema = z.object({
  imageId: z.string().regex(IMAGE_ID_PATTERN),
  buildId: z.string().min(1),
  deployedAt: z.string(),
});
const deployStateSchema = z.object({
  version: z.literal(1),
  current: imageRecordSchema,
  previous: imageRecordSchema.nullable(),
  pending: imageRecordSchema.nullable(),
});
type ImageRecord = z.infer<typeof imageRecordSchema>;
type DeployState = z.infer<typeof deployStateSchema>;

async function readState(ctx: DeployContext): Promise<DeployState | null> {
  if (!existsSync(ctx.stateFile)) return null;
  const raw: unknown = JSON.parse(await Bun.file(ctx.stateFile).text());
  return deployStateSchema.parse(raw);
}

async function writeState(ctx: DeployContext, state: DeployState): Promise<void> {
  const tmp = join(ctx.tmpDir, `deploy-state-${process.pid}.json`);
  await Bun.write(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, ctx.stateFile);
}

async function waitForRuntimeHealth(ctx: DeployContext) {
  const deadline = Date.now() + APP_START_TIMEOUT_MS;
  for (;;) {
    try {
      return await getRuntimeHealth(ctx);
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(
          `the app did not become healthy within ${APP_START_TIMEOUT_MS / 1000}s (${error instanceof Error ? error.message : String(error)}); check docker compose logs app`,
        );
      }
    }
    await Bun.sleep(2_000);
  }
}

interface DrainOutcome {
  revision: number;
}

/**
 * Closes admission via the durable revision CAS and waits (bounded) until
 * every blocking count is zero. On timeout it throws WITHOUT stopping
 * anything: games keep running and maintenance stays draining, so nothing is
 * ever killed. All maintenance operations run inside the running app
 * container — host Docker privilege is the authorization.
 */
async function drainApp(ctx: DeployContext, waitTimeoutS: number): Promise<DrainOutcome> {
  const status = await getServiceStatus(ctx);
  let revision: number;
  if (status.maintenance.mode === 'open') {
    log(`entering draining maintenance (revision ${status.maintenance.revision})`);
    const entered = await drainAdmission(ctx, status.maintenance.revision);
    revision = entered.revision;
  } else {
    log(`maintenance already draining (revision ${status.maintenance.revision}); continuing`);
    revision = status.maintenance.revision;
  }
  const deadline = Date.now() + waitTimeoutS * 1000;
  for (;;) {
    const current = await inspectRunning(ctx);
    if (current.revision !== revision) {
      throw new Error(
        `maintenance revision moved ${revision} -> ${current.revision} during the drain; another operator interfered — aborting without touching containers`,
      );
    }
    if (current.ready) {
      log(
        `drained (active matches ${current.activeMatches}, reservations ${current.liveReservations}, waiting ${current.waitingTickets}, pending results ${current.pendingResults})`,
      );
      return { revision };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `drain not ready within ${waitTimeoutS}s (active matches ${current.activeMatches}, reservations ${current.liveReservations}, pending results ${current.pendingResults}). Nothing was stopped and no game was killed; maintenance stays draining — wait for games to finish and re-run, or resume with: bun run maintenance resume`,
      );
    }
    await Bun.sleep(2_000);
  }
}

/** Re-checks the durable state immediately before the old container stops. */
async function assertStillDrained(ctx: DeployContext, revision: number): Promise<void> {
  const current = await inspectRunning(ctx);
  if (current.revision !== revision || !current.ready) {
    throw new Error(
      `durable maintenance changed before the stop (revision ${current.revision}, ready ${current.ready}); aborting without touching containers`,
    );
  }
}

/**
 * Reopens admission through the full CAS: the revision is re-read from the
 * durable row and the runtime epoch comes from a fresh public /health proof
 * of the live runtime lease.
 */
async function resumeAfterChecks(ctx: DeployContext, revision: number): Promise<void> {
  const health = await getRuntimeHealth(ctx);
  const current = await inspectRunning(ctx);
  if (current.revision !== revision) {
    throw new Error('durable revision changed before resume; refusing to reopen admission');
  }
  log(`resuming admission (revision ${revision}, runtime epoch ${health.runtimeEpoch})`);
  const resumed = await resumeAdmission(ctx, revision, health.runtimeEpoch);
  if (resumed.mode !== 'open') {
    throw new Error(
      `resume returned mode ${resumed.mode}; inspect with: bun run maintenance status`,
    );
  }
}

function describeImage(record: ImageRecord | null): string {
  return record
    ? `${record.imageId} (build ${record.buildId}, deployed ${record.deployedAt})`
    : '(none recorded)';
}

function reportClosedFailure(scope: string, imageId: string, error: unknown): 1 {
  log(`${scope} FAILED: ${error instanceof Error ? error.message : String(error)}`);
  log(
    'Automatic reopening was not confirmed. Verify durable maintenance before recovery; no automatic rollback or forced resume was attempted.',
  );
  log('Recovery options:');
  log(
    `  - for an initial installation with no previous image, fix the cause and retry: bun run deploy install --image ${imageId}`,
  );
  log(
    '  - for a failed update, restore the last healthy image: bun run deploy rollback --schema-compatible',
  );
  log(
    '    (rollback never down-migrates; it asserts the previous build tolerates the current schema)',
  );
  return 1;
}

// --- commands ----------------------------------------------------------------

/** Builds the candidate image from the checkout; prints its exact image ID. */
export async function cmdBuild(options: { tag?: string }): Promise<number> {
  const ctx = await loadContext({ requireOrigin: false });
  const lock = acquireLock(ctx.lockFile, 'build');
  try {
    const tag = options.tag ?? 'spelltype:local';
    const buildId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
    await buildImage(repoRoot, tag, buildId);
    const imageId = await resolveImageId(tag);
    console.log(
      JSON.stringify(
        {
          event: 'built',
          tag,
          buildId,
          imageId,
          deploy: `bun run deploy deploy --image ${imageId}`,
        },
        null,
        2,
      ),
    );
    return 0;
  } finally {
    lock.release();
  }
}

/** Creates the 0600 credential files from exported environment values. */
export async function cmdSecrets(): Promise<number> {
  const ctx = await loadContext({ requireOrigin: false });
  const password = process.env.POSTGRES_PASSWORD?.trim();
  const bridgeAppKey = process.env.WECHAT_BRIDGE_APP_KEY?.trim();
  const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!password) throw new Error('Export POSTGRES_PASSWORD, then re-run: bun run deploy secrets');
  if (!bridgeAppKey || bridgeAppKey.length < 16) {
    throw new Error(
      'Export WECHAT_BRIDGE_APP_KEY (16+ characters), then re-run: bun run deploy secrets',
    );
  }
  if (!deepseekKey) throw new Error('Export DEEPSEEK_API_KEY, then re-run: bun run deploy secrets');
  const databaseUrl =
    `postgres://${encodeURIComponent(ctx.postgresUser)}:${encodeURIComponent(password)}` +
    `@database:5432/${encodeURIComponent(ctx.postgresDb)}`;
  const secrets: Array<[string, string]> = [
    ['postgres_password', password],
    ['wechat_bridge_app_key', bridgeAppKey],
    ['deepseek_api_key', deepseekKey],
    ['database_url', databaseUrl],
  ];
  // Optional machine token for the /api/ops/maintenance API (CI/scripts).
  const maintenanceToken = process.env.MAINTENANCE_TOKEN?.trim();
  if (maintenanceToken !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(maintenanceToken)) {
      throw new Error('MAINTENANCE_TOKEN must contain 64 lowercase hexadecimal characters.');
    }
    secrets.push(['maintenance_token', maintenanceToken]);
  } else {
    log(
      'MAINTENANCE_TOKEN not exported; skipping the optional ops API token (ops API stays disabled).',
    );
  }
  for (const [name, value] of secrets) {
    const path = secretFile(ctx, name);
    if (existsSync(path)) {
      log(`exists, leaving unchanged: ${path}`);
      continue;
    }
    createSecretFile(ctx, name, value);
    log(`created ${path} (0600)`);
  }
  return 0;
}

/**
 * Initial bootstrap, safe with no app container and an empty database:
 * database -> migrate (durable draining) -> app -> /health -> resume (CAS).
 */
export async function cmdInstall(options: { image: string }): Promise<number> {
  const ctx = await loadContext({ requireOrigin: true });
  const lock = acquireLock(ctx.lockFile, 'install');
  try {
    requireAllSecrets(ctx);
    const imageId = await resolveImageId(options.image);
    const candidate = await checkCandidate(imageId);
    log(`installing candidate ${imageId} (build ${candidate.buildId})`);
    if (await inspectRunningApp(ctx)) {
      throw new Error(
        'an app container is already running; use: bun run deploy deploy --image <ref>',
      );
    }
    await ensureDatabase(ctx);
    try {
      await runMigrate(ctx, imageId);
      await startApp(ctx, imageId);
      const health = await waitForRuntimeHealth(ctx);
      if (health.buildId !== candidate.buildId) {
        throw new Error(
          `running build ${health.buildId} does not match candidate ${candidate.buildId}; refusing to resume`,
        );
      }
      const status = await inspectRunning(ctx);
      if (status.mode !== 'draining') {
        throw new Error(
          'migration did not leave maintenance draining; refusing to resume automatically',
        );
      }
      const prior = await readState(ctx);
      await writeState(ctx, {
        version: 1,
        current: { imageId, buildId: candidate.buildId, deployedAt: new Date().toISOString() },
        previous: prior?.current ?? null,
        pending: null,
      });
      await resumeAfterChecks(ctx, status.revision);
      log('install complete');
      return 0;
    } catch (error) {
      return reportClosedFailure('INSTALL', imageId, error);
    }
  } finally {
    lock.release();
  }
}

/**
 * Ordinary update: verify candidate -> drain (CAS, bounded) -> stop old app
 * -> migrate once -> start candidate -> verify health/identity -> resume CAS.
 * Any failure after the stop keeps maintenance closed.
 */
export async function cmdDeploy(options: {
  image: string;
  waitTimeoutS?: number;
  expectBuild?: string;
}): Promise<number> {
  const ctx = await loadContext({ requireOrigin: true });
  const lock = acquireLock(ctx.lockFile, 'deploy');
  try {
    const waitTimeoutS = options.waitTimeoutS ?? DEFAULT_DRAIN_TIMEOUT_S;
    const imageId = await resolveImageId(options.image);
    const candidate = await checkCandidate(imageId);
    if (options.expectBuild !== undefined && options.expectBuild !== candidate.buildId) {
      throw new Error(
        `candidate build ${candidate.buildId} does not match --expect-build ${options.expectBuild}`,
      );
    }
    log(`deploying candidate ${imageId} (build ${candidate.buildId})`);
    const running = await inspectRunningApp(ctx);
    if (!running) {
      throw new Error(
        'no app container is running; bootstrap with: bun run deploy install --image <ref> (or roll back with: bun run deploy rollback)',
      );
    }
    const prior = await readState(ctx);
    const oldHealth = await getRuntimeHealth(ctx);
    const previous: ImageRecord = prior?.pending
      ? prior.current
      : {
          imageId: running.imageId,
          buildId: oldHealth.buildId,
          deployedAt: new Date().toISOString(),
        };
    const { revision } = await drainApp(ctx, waitTimeoutS);
    await writeState(ctx, {
      version: 1,
      current: previous,
      previous: prior?.previous ?? null,
      pending: { imageId, buildId: candidate.buildId, deployedAt: new Date().toISOString() },
    });
    await assertStillDrained(ctx, revision);
    try {
      await stopApp(ctx);
      await runMigrate(ctx, imageId);
      await startApp(ctx, imageId);
      const health = await waitForRuntimeHealth(ctx);
      if (health.buildId !== candidate.buildId) {
        throw new Error(
          `running build ${health.buildId} does not match candidate ${candidate.buildId}; keeping maintenance closed`,
        );
      }
      const status = await getServiceStatus(ctx);
      if (status.maintenance.mode !== 'draining') {
        throw new Error('status does not show draining maintenance; refusing to resume');
      }
      await writeState(ctx, {
        version: 1,
        current: { imageId, buildId: candidate.buildId, deployedAt: new Date().toISOString() },
        previous,
        pending: null,
      });
      await resumeAfterChecks(ctx, revision);
      log(`deploy complete: ${imageId} (build ${candidate.buildId})`);
      log(`previous image for rollback: ${describeImage(previous)}`);
      return 0;
    } catch (error) {
      return reportClosedFailure('DEPLOY', imageId, error);
    }
  } finally {
    lock.release();
  }
}

/**
 * Explicit rollback to the recorded previous image (or --image). It drains
 * first when games are running, never runs migrations and never down-migrates;
 * `--schema-compatible` asserts the previous build tolerates the current
 * forward schema. When the app is already stopped (failed-update state), it
 * reads the durable state with a one-shot maintenance container and proceeds.
 */
export async function cmdRollback(options: {
  image?: string;
  schemaCompatible?: boolean;
  waitTimeoutS?: number;
}): Promise<number> {
  const ctx = await loadContext({ requireOrigin: true });
  const lock = acquireLock(ctx.lockFile, 'rollback');
  try {
    const waitTimeoutS = options.waitTimeoutS ?? DEFAULT_DRAIN_TIMEOUT_S;
    const state = await readState(ctx);
    let target: ImageRecord;
    if (options.image !== undefined) {
      const imageId = await resolveImageId(options.image);
      const recorded =
        state?.previous?.imageId === imageId
          ? state.previous
          : state?.current.imageId === imageId
            ? state.current
            : null;
      target = recorded ?? { imageId, buildId: 'unknown', deployedAt: 'explicit' };
    } else {
      const previous = state?.pending ? state.current : (state?.previous ?? null);
      if (previous === null) {
        throw new Error(
          'no previous image is recorded in deploy-state.json; pass --image <ref> to roll back to an explicit reference',
        );
      }
      await resolveImageId(previous.imageId); // must still exist locally
      target = previous;
    }
    if (
      (state === null || state.pending !== null || state.current.imageId !== target.imageId) &&
      !options.schemaCompatible
    ) {
      throw new Error(
        'rolling back to a different image runs previous code against the CURRENT (forward-migrated) schema. ' +
          'Pass --schema-compatible to assert the previous build tolerates it (true for additive migrations). ' +
          'The schema is never down-migrated.',
      );
    }
    const candidate = await checkCandidate(target.imageId);
    if (target.buildId !== 'unknown' && target.buildId !== candidate.buildId) {
      throw new Error(
        'Rollback image identity differs from its recorded build; refusing to stop the app.',
      );
    }
    target = { ...target, buildId: candidate.buildId };
    log(`rolling back to ${target.imageId} (build ${target.buildId})`);
    const running = await inspectRunningApp(ctx);
    let revision: number;
    if (running && !state?.pending) {
      const drained = await drainApp(ctx, waitTimeoutS);
      await assertStillDrained(ctx, drained.revision);
      revision = drained.revision;
      if (state) await writeState(ctx, { ...state, pending: target });
      await stopApp(ctx);
    } else {
      const durable = await inspectOneShot(ctx, target.imageId);
      if (
        durable.mode !== 'draining' ||
        durable.activeMatches !== 0 ||
        durable.liveReservations !== 0 ||
        durable.waitingTickets !== 0 ||
        durable.pendingResults !== 0
      ) {
        throw new Error(
          'failed-update recovery requires durable draining with no matches, reservations, queue entries or unsettled results; admission remains closed',
        );
      }
      revision = durable.revision;
      if (state) await writeState(ctx, { ...state, pending: target });
      if (running) await stopApp(ctx);
      log(`recovering with durable maintenance draining (revision ${revision})`);
    }
    try {
      await startApp(ctx, target.imageId);
      const health = await waitForRuntimeHealth(ctx);
      if (target.buildId !== 'unknown' && health.buildId !== target.buildId) {
        throw new Error(
          `running build ${health.buildId} does not match rollback target ${target.buildId}; keeping maintenance closed`,
        );
      }
      await writeState(ctx, {
        version: 1,
        current: { ...target, buildId: health.buildId, deployedAt: new Date().toISOString() },
        previous:
          state?.current.imageId === target.imageId ? state.previous : (state?.current ?? null),
        pending: null,
      });
      await resumeAfterChecks(ctx, revision);
      log(`rollback complete: ${target.imageId} (build ${target.buildId})`);
      return 0;
    } catch (error) {
      return reportClosedFailure('ROLLBACK', target.imageId, error);
    }
  } finally {
    lock.release();
  }
}

/**
 * Standalone maintenance operations. Two transports:
 *  - default: one-shot maintenance entry inside the running app container
 *    (host Docker privilege; used by local deployment/bootstrap);
 *  - --http: the bearer-only /api/ops/maintenance machine API, for remote
 *    CI/platform automation without Docker access (config via environment:
 *    SPELLTYPE_OPS_URL or SPELLTYPE_PUBLIC_ORIGIN + MAINTENANCE_TOKEN[_FILE]).
 * `wait` is a pure observer on either transport: bounded, mutation-free, and
 * it reports ready only while the draining revision never moved.
 */
export async function cmdMaintenance(
  action: 'status' | 'drain' | 'wait' | 'resume',
  options: { timeoutS?: number; viaHttp?: boolean } = {},
): Promise<number> {
  const timeoutS = options.timeoutS ?? DEFAULT_DRAIN_TIMEOUT_S;
  if (options.viaHttp) {
    const client = await loadOpsClient();
    if (action === 'status') {
      console.log(JSON.stringify(await opsDrainStatus(client), null, 2));
      return 0;
    }
    if (action === 'wait') {
      console.log(
        JSON.stringify(
          await waitForDrainReady(() => opsDrainStatus(client), { timeoutS }),
          null,
          2,
        ),
      );
      return 0;
    }
    if (action === 'drain') {
      const status = await opsDrainStatus(client);
      let expectedRevision = status.revision;
      if (status.mode === 'draining') {
        log(`maintenance already draining (revision ${status.revision}); waiting`);
      } else {
        const entered = await opsDrain(client, status.revision);
        expectedRevision = entered.revision;
        log(`maintenance draining (revision ${entered.revision})`);
      }
      console.log(
        JSON.stringify(
          await waitForDrainReady(() => opsDrainStatus(client), { timeoutS, expectedRevision }),
          null,
          2,
        ),
      );
      return 0;
    }
    const status = await opsDrainStatus(client);
    if (status.mode === 'open') {
      log('maintenance is already open');
      return 0;
    }
    if (!status.ready) {
      log(
        `warning: drain counters are not zero (matches ${status.activeMatches}, reservations ${status.liveReservations}, pending ${status.pendingResults}); resuming now admits new matches while those finish`,
      );
    }
    const health = await getRuntimeHealth({ appBaseUrl: client.baseUrl });
    const resumed = await opsResume(client, status.revision, health.runtimeEpoch);
    console.log(JSON.stringify(resumed, null, 2));
    return 0;
  }

  const ctx = await loadContext({ requireOrigin: false });
  if (action === 'status') {
    console.log(JSON.stringify(await inspectRunning(ctx), null, 2));
    return 0;
  }
  const lock = acquireLock(ctx.lockFile, `maintenance-${action}`);
  try {
    if (action === 'wait') {
      console.log(
        JSON.stringify(await waitForDrainReady(() => inspectRunning(ctx), { timeoutS }), null, 2),
      );
      return 0;
    }
    if (action === 'drain') {
      await drainApp(ctx, timeoutS);
      console.log(JSON.stringify(await inspectRunning(ctx), null, 2));
      return 0;
    }
    const status = await inspectRunning(ctx);
    if (status.mode === 'open') {
      log('maintenance is already open');
      return 0;
    }
    if (!status.ready) {
      log(
        `warning: drain counters are not zero (matches ${status.activeMatches}, reservations ${status.liveReservations}, pending ${status.pendingResults}); resuming now admits new matches while those finish`,
      );
    }
    await resumeAfterChecks(ctx, status.revision);
    return 0;
  } finally {
    lock.release();
  }
}

/** Operator overview: compose state, runtime proof, maintenance, image history. */
export async function cmdStatus(): Promise<number> {
  const ctx = await loadContext({ requireOrigin: false });
  const state = await readState(ctx);
  log('== compose ==');
  const ps = await compose(ctx, ['ps']);
  if (ps.stdout.trim().length > 0) process.stdout.write(ps.stdout);
  if (ps.stderr.trim().length > 0) process.stderr.write(ps.stderr);
  log('');
  log('== maintenance ==');
  try {
    console.log(JSON.stringify(await inspectRunning(ctx), null, 2));
  } catch (error) {
    log(`unreachable: ${error instanceof Error ? error.message : String(error)}`);
  }
  log('== runtime ==');
  try {
    const health = await getRuntimeHealth(ctx);
    log(
      `healthy: build ${health.buildId}, protocol ${health.protocolVersion}, runtime epoch ${health.runtimeEpoch}`,
    );
  } catch (error) {
    log(`no runtime proof: ${error instanceof Error ? error.message : String(error)}`);
  }
  log('== deployed images ==');
  log(`current:  ${describeImage(state?.current ?? null)}`);
  log(`previous: ${describeImage(state?.previous ?? null)}`);
  if (state?.previous === null)
    log('(no rollback target recorded; deploys record one automatically)');
  return 0;
}

/** Removes a stale host lock after the operator confirmed the holder is dead. */
export async function cmdUnlock(): Promise<number> {
  const stateDir = process.env.SPELLTYPE_STATE_DIR?.trim() || join(repoRoot, '.deploy');
  const holder = clearStaleLock(join(stateDir, '.deploy-lock'));
  log(`removed lock (holder: ${JSON.stringify(holder)})`);
  return 0;
}
