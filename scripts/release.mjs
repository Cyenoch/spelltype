// Host-side release CLI. Serialized by a host lock, fail-closed everywhere,
// and the only writer of release state on this machine:
//
//   bun run deploy stage   [--release-id <32hex>]
//   bun run deploy deploy  [--release-id <32hex>] [--expect <id>] [--wait-timeout <s>]
//   bun run deploy check   --release-id <32hex>
//   bun run deploy activate --release-id <32hex> [--expect <id>]
//   bun run deploy api     --release-id <32hex>
//   bun run deploy retire  --release-id <32hex>
//   bun run deploy collect --release-id <32hex>
//   bun run deploy status
//   bun run deploy secrets
//   bun run deploy unlock
//
// deploy performs: protected stage (or verified reuse) -> admin stage ->
// game project up -> admin check -> CAS activate. It returns as soon as the new release owns admission; games on
// the previous release keep running untouched. Rollback is the same safe
// path: deploy --release-id <previous>. Never run two release commands at
// once; never collect a release that is not confirmed retired.
//
// Use the package script so builds inherit the configured native compiler options.

import { existsSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ADMIN_TOKEN_PATTERN, imageRef, RELEASE_ID_PATTERN } from './release/constants.mjs';
import { ensureImage, publishAssets, stageSnapshot, verifySnapshot } from './release/artifacts.mjs';
import {
  baseComposeEnv,
  gameComposeEnv,
  gameSecrets,
  baseSecrets,
  loadContext,
  readAdminToken,
  secretFile,
} from './release/env.mjs';
import { acquireLock, clearStaleLock } from './release/lock.mjs';
import {
  baseCompose,
  dockerMaybe,
  gameCompose,
  removeImage,
  tagImage,
} from './release/dockerx.mjs';
import {
  activateRelease,
  adminHealth,
  AdminError,
  checkRelease,
  completeRetirement,
  controlActiveReleaseId,
  getReleaseState,
  probeRetirement,
  stageRelease,
  versionState,
} from './release/registry.mjs';
import {
  collectPlan,
  guardSnapshotCapacity,
  incompleteSnapshots,
  removeAssetsDir,
  removeSnapshotDir,
} from './release/retention.mjs';

const log = console.error;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The admin API validates operation ids as UUIDs.
const operationId = () => crypto.randomUUID();

function requireReleaseId(value) {
  if (value === undefined)
    throw new Error('This command requires --release-id <32 lowercase hex>.');
  if (!RELEASE_ID_PATTERN.test(value))
    throw new Error(`--release-id must be 32 lowercase hex characters, got "${value}".`);
  return value;
}

function parseArgs(argv) {
  const args = {
    command: undefined,
    releaseId: undefined,
    expect: undefined,
    waitTimeout: undefined,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--release-id') args.releaseId = argv[++index];
    else if (arg === '--expect') args.expect = argv[++index];
    else if (arg === '--wait-timeout') args.waitTimeout = Number(argv[++index]);
    else if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option "${arg}".`);
    else if (args.command === undefined) args.command = arg;
    else throw new Error(`Unexpected argument "${arg}".`);
  }
  if (
    args.waitTimeout !== undefined &&
    (!Number.isFinite(args.waitTimeout) || args.waitTimeout <= 0)
  ) {
    throw new Error('--wait-timeout must be a positive number of seconds.');
  }
  return args;
}

async function retryableAdmin(attempt, { attempts = 45, delayMs = 2000 } = {}) {
  let lastError;
  for (let round = 1; round <= attempts; round++) {
    try {
      return await attempt();
    } catch (error) {
      const status = error instanceof AdminError ? error.status : 0;
      const transient =
        status === 0 || status === 500 || status === 502 || status === 503 || status === 504;
      if (!transient) throw error;
      lastError = error;
      log(`attempt ${round}/${attempts} failed (${error.message}); retrying`);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function requireBaseUp(ctx) {
  try {
    await adminHealth(ctx);
  } catch (error) {
    throw new Error(
      `The stable API admin endpoint at ${ctx.adminUrl} is not answering (${error.message}). Start the base stack first: docker compose --env-file deploy/compose.env -p ${ctx.baseProject} up -d`,
    );
  }
}

async function currentActive(ctx) {
  const state = await getReleaseState(ctx);
  return { state, active: controlActiveReleaseId(state) };
}

// Best-effort compose command for one per-release game project. Always scoped
// to compose.release.yaml, the exact project name and the interpolation env
// deploy itself used; a failure is reported as false with its reason, never
// silently swallowed and never allowed to touch the base stack.
async function gameComposeBestEffort(ctx, releaseId, args) {
  try {
    await gameCompose(ctx.gameProject(releaseId), args, {
      env: gameComposeEnv(ctx, releaseId, imageRef(releaseId)),
    });
    return true;
  } catch (error) {
    log(
      `docker compose ${args.join(' ')} failed for project ${ctx.gameProject(releaseId)}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

// --- commands ----------------------------------------------------------------

async function cmdStage(args) {
  const lock = acquireLock(
    (await loadContext({ requireOrigin: false, requireToken: false })).lockFile,
    'stage',
  );
  try {
    const ctx = await loadContext({ requireOrigin: false });
    let releaseId = args.releaseId === undefined ? undefined : requireReleaseId(args.releaseId);
    if (releaseId !== undefined && existsSync(join(ctx.artifactsDir, releaseId, 'snapshot.json'))) {
      log(
        `snapshot for ${releaseId} already exists; verifying and reusing (never rebuilding an existing release id)`,
      );
      await ensureImage(ctx, releaseId, { log });
      const { snapshot } = await verifySnapshot(ctx, releaseId, { log });
      return { releaseId, artifactDigest: snapshot.artifactDigest, reused: true };
    }
    await guardSnapshotCapacity(ctx);
    const staged = await stageSnapshot(ctx, { releaseId, log });
    const image = await ensureImage(ctx, staged.snapshot.releaseId, { log });
    return {
      releaseId: staged.snapshot.releaseId,
      artifactDigest: staged.snapshot.artifactDigest,
      imageId: image.id,
      reused: false,
    };
  } finally {
    lock.release();
  }
}

async function cmdDeploy(args) {
  const lock = acquireLock(
    (await loadContext({ requireOrigin: false, requireToken: false })).lockFile,
    'deploy',
  );
  try {
    const ctx = await loadContext({ secrets: gameSecrets() });
    await requireBaseUp(ctx);
    const before = await currentActive(ctx);
    let releaseId;
    let snapshot;
    if (args.releaseId === undefined) {
      await guardSnapshotCapacity(ctx);
      const staged = await stageSnapshot(ctx, { log });
      snapshot = staged.snapshot;
      releaseId = snapshot.releaseId;
    } else {
      // An explicit release id always deploys its own verified staged bytes;
      // a missing or corrupted snapshot is an error, never a rebuild.
      releaseId = requireReleaseId(args.releaseId);
      ({ snapshot } = await verifySnapshot(ctx, releaseId, { log }));
    }
    const registered = before.state.versions.find((version) => version.releaseId === releaseId);
    if (registered?.state === 'retired') throw new Error(`Release ${releaseId} is retired.`);
    if (registered && registered.artifactDigest !== snapshot.artifactDigest) {
      throw new Error(`Release ${releaseId} does not match its registered artifact digest.`);
    }
    const image = await ensureImage(ctx, releaseId, { log });
    await publishAssets(ctx, releaseId, { log });

    const op = operationId();
    if (!registered || registered.state === 'staged') {
      log(`staging release ${releaseId} in the registry (operation ${op})`);
      await stageRelease(ctx, {
        operationId: op,
        releaseId,
        artifactDigest: snapshot.artifactDigest,
      });
    } else {
      log(`rechecking retained ${registered.state} release ${releaseId} (operation ${op})`);
    }

    const waitTimeout = args.waitTimeout ?? 240;
    log(`starting game project ${ctx.gameProject(releaseId)} (wait up to ${waitTimeout}s)`);
    await gameCompose(
      ctx.gameProject(releaseId),
      ['up', '-d', '--no-recreate', '--wait', '--wait-timeout', String(Math.round(waitTimeout))],
      { env: gameComposeEnv(ctx, releaseId, image.reference) },
    );

    log('checking candidate runtime through the stable API');
    await retryableAdmin(() => checkRelease(ctx, { operationId: op, releaseId }));

    // No edge interaction here: routing is fully static (32-hex path regexp
    // dialing game-<id>:3000), so activating a release never reloads or
    // restarts the edge and existing sockets on the old release stay intact.
    const expected = args.expect === undefined ? before.active : args.expect;
    log(`activating ${releaseId} (expected active: ${expected ?? 'none'})`);
    await activateRelease(ctx, { operationId: op, releaseId, expectedReleaseId: expected });
    return {
      releaseId,
      artifactDigest: snapshot.artifactDigest,
      imageId: image.id,
      previousActive: before.active,
      active: releaseId,
      operationId: op,
    };
  } finally {
    lock.release();
  }
}

async function cmdCheck(args) {
  const releaseId = requireReleaseId(args.releaseId);
  const lock = acquireLock(
    (await loadContext({ requireOrigin: false, requireToken: false })).lockFile,
    'check',
  );
  try {
    const ctx = await loadContext({ requireOrigin: false });
    await requireBaseUp(ctx);
    const result = await checkRelease(ctx, { operationId: operationId(), releaseId });
    return { releaseId, check: result };
  } finally {
    lock.release();
  }
}

async function cmdActivate(args) {
  const releaseId = requireReleaseId(args.releaseId);
  const lock = acquireLock(
    (await loadContext({ requireOrigin: false, requireToken: false })).lockFile,
    'activate',
  );
  try {
    const ctx = await loadContext({ requireOrigin: false });
    await requireBaseUp(ctx);
    await ensureImage(ctx, releaseId, { log });
    await publishAssets(ctx, releaseId, { log });
    const before = await currentActive(ctx);
    const expected = args.expect === undefined ? before.active : args.expect;
    const op = before.state.versions.find(
      (version) => version.releaseId === releaseId,
    )?.operationId;
    if (!op) throw new Error(`Release ${releaseId} is not registered; deploy and check it first.`);
    await activateRelease(ctx, { operationId: op, releaseId, expectedReleaseId: expected });
    return { releaseId, previousActive: before.active, active: releaseId, operationId: op };
  } finally {
    lock.release();
  }
}

async function cmdApi(args) {
  const releaseId = requireReleaseId(args.releaseId);
  const lock = acquireLock(
    (await loadContext({ requireOrigin: false, requireToken: false })).lockFile,
    'api',
  );
  try {
    const ctx = await loadContext({ secrets: baseSecrets() });
    const { snapshot } = await verifySnapshot(ctx, releaseId, { log });
    const image = await ensureImage(ctx, releaseId, { log });
    const stable = ctx.apiImage ?? 'spelltype/api:stable';
    log(`promoting ${image.reference} to ${stable}`);
    await tagImage(image.reference, stable);
    await baseCompose(ctx.baseProject, ['up', '-d', '--wait', '--wait-timeout', '120', 'api'], {
      env: baseComposeEnv(ctx),
    });
    await retryableAdmin(() => adminHealth(ctx), { attempts: 30 });
    return { releaseId, artifactDigest: snapshot.artifactDigest, apiImage: stable };
  } finally {
    lock.release();
  }
}

async function cmdRetire(args) {
  const releaseId = requireReleaseId(args.releaseId);
  const lock = acquireLock(
    (await loadContext({ requireOrigin: false, requireToken: false })).lockFile,
    'retire',
  );
  try {
    const ctx = await loadContext({ requireOrigin: false });
    await requireBaseUp(ctx);
    const probe = await probeRetirement(ctx, releaseId);
    if (!probe.ready) {
      log(
        `release ${releaseId} is not drainable yet (runtimeKnown=${probe.runtimeKnown}): ` +
          `${probe.activeMatches} active matches, ${probe.liveReservations} live reservations, ` +
          `${probe.waitingTickets} waiting tickets, ${probe.pendingResults} pending results`,
      );
      return { releaseId, retired: false, probe };
    }
    const result = await completeRetirement(ctx, {
      releaseId,
      admissionEpoch: probe.admissionEpoch,
    });
    log(`retirement of ${releaseId} sealed; stopping its game project`);
    const stopped = await gameComposeBestEffort(ctx, releaseId, ['stop']);
    // Report the state the seal itself returned, not a view captured before it.
    return { releaseId, retired: true, state: versionState(result, releaseId), stopped, result };
  } finally {
    lock.release();
  }
}

async function cmdCollect(args) {
  const releaseId = requireReleaseId(args.releaseId);
  const lock = acquireLock(
    (await loadContext({ requireOrigin: false, requireToken: false })).lockFile,
    'collect',
  );
  try {
    const ctx = await loadContext({ requireOrigin: false });
    await requireBaseUp(ctx);
    const { state } = await currentActive(ctx);
    const plan = await collectPlan(ctx, state, releaseId);
    log(
      `collect plan for ${releaseId}: ${JSON.stringify(plan.keepReasons.length > 0 ? { ...plan } : plan)}`,
    );

    const removed = {};
    removed.project = await gameComposeBestEffort(ctx, releaseId, ['down', '--remove-orphans']);
    if (plan.removeImage) {
      removed.image = await removeImage(imageRef(releaseId));
      if (!removed.image) log(`no local image ${imageRef(releaseId)} to remove`);
    }
    if (plan.removeAssets) removed.assets = await removeAssetsDir(ctx, releaseId);
    if (plan.removeSnapshot) removed.snapshot = await removeSnapshotDir(ctx, releaseId);
    return { ...plan, removed };
  } finally {
    lock.release();
  }
}

async function cmdStatus() {
  const ctx = await loadContext({ requireOrigin: false, requireToken: false });
  // status stays usable without credentials but shows the registry when the
  // token is available in the environment.
  ctx.token = await readAdminToken().catch(() => null);
  const summary = {
    adminUrl: ctx.adminUrl,
    baseProject: ctx.baseProject,
    runtimeNetwork: ctx.runtimeNetwork,
    registry: null,
    snapshots: [],
    incompleteSnapshots: [],
    images: [],
  };
  if (ctx.token) {
    try {
      summary.registry = await getReleaseState(ctx);
    } catch (error) {
      summary.registryError = error.message;
    }
  }
  const artifacts = await import('node:fs/promises').then((fs) =>
    fs.readdir(ctx.artifactsDir).catch(() => []),
  );
  for (const name of artifacts) {
    const file = join(ctx.artifactsDir, name, 'snapshot.json');
    if (existsSync(file)) summary.snapshots.push(JSON.parse(await Bun.file(file).text()));
  }
  summary.incompleteSnapshots = await incompleteSnapshots(ctx);
  const listed = await dockerMaybe(['image', 'ls', '--format', '{{json .}}', 'spelltype/release']);
  if (listed) {
    summary.images = listed
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }
  return summary;
}

async function cmdSecrets() {
  const ctx = await loadContext({ requireOrigin: false, requireToken: false });
  const read = async (name) => {
    const inline = process.env[name]?.trim();
    const file = process.env[`${name}_FILE`]?.trim();
    if (inline && file) throw new Error(`Set only ${name} or ${name}_FILE, not both.`);
    const value = file ? (await Bun.file(file).text()).trim() : inline;
    return value === undefined || value === '' ? null : value;
  };
  // Exclusive create with owner-only mode from the first byte: no world-
  // readable window, and the kernel rejects a racing second writer instead
  // of overwriting an existing secret. Errors never quote secret values.
  const write = async (name, value) => {
    const path = secretFile(ctx, name);
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'EEXIST')
        throw new Error(`Secret file ${path} already exists; delete it explicitly to replace it.`);
      throw error;
    }
    try {
      await handle.writeFile(`${value}\n`);
    } catch (error) {
      // The path still holds only the partial bytes this exclusive create
      // produced; drop them so a retry starts clean instead of wedging.
      await rm(path, { force: true }).catch(() => {});
      throw error;
    } finally {
      await handle.close();
    }
    log(`wrote ${path}`);
  };

  // Every input is validated before the first byte is written, so a missing
  // or malformed later value can never leave a partially seeded secrets dir.
  const token = await read('RELEASE_ADMIN_TOKEN');
  if (token === null)
    throw new Error(
      'RELEASE_ADMIN_TOKEN (or *_FILE) is required; it must be 64 lowercase hex characters.',
    );
  if (!ADMIN_TOKEN_PATTERN.test(token))
    throw new Error('RELEASE_ADMIN_TOKEN must be 64 lowercase hexadecimal characters.');
  const password = await read('POSTGRES_PASSWORD');
  if (password === null)
    throw new Error('POSTGRES_PASSWORD (or *_FILE) is required to derive the database_url secret.');
  const deepseek = await read('DEEPSEEK_API_KEY');
  if (deepseek === null) {
    log(
      'warning: DEEPSEEK_API_KEY not provided; game runtimes will not generate spells until deploy/secrets has deepseek_api_key',
    );
  }

  const databaseUrl = `postgres://${encodeURIComponent(ctx.postgresUser)}:${encodeURIComponent(password)}@database:5432/${encodeURIComponent(ctx.postgresDb)}`;
  const writes = [
    ['release_admin_token', token],
    ['postgres_password', password],
    ['database_url', databaseUrl],
    ...(deepseek === null ? [] : [['deepseek_api_key', deepseek]]),
  ];
  for (const [name] of writes) {
    const path = secretFile(ctx, name);
    if (existsSync(path))
      throw new Error(`Secret file ${path} already exists; delete it explicitly to replace it.`);
  }
  for (const [name, value] of writes) await write(name, value);
  return {
    secretsDir: ctx.secretsDir,
    written: writes.map(([name]) => name),
  };
}

async function cmdUnlock() {
  const ctx = await loadContext({ requireOrigin: false, requireToken: false });
  const holder = clearStaleLock(ctx.lockFile);
  return { unlocked: ctx.lockFile, formerHolder: holder };
}

// --- dispatch ----------------------------------------------------------------

const usage = `usage: bun run deploy <command> [options]

commands:
  stage    [--release-id <32hex>]                 build (or reuse) a protected artifact snapshot and its image
  deploy   [--release-id <32hex>] [--expect <id>] [--wait-timeout <s>]
                                                  stage -> up candidate -> check -> CAS activate
  check    --release-id <32hex>                   ask the stable API to verify a running candidate
  activate --release-id <32hex> [--expect <id>]   CAS-activate an already checked candidate
  api      --release-id <32hex>                   promote a staged snapshot to the stable API image
  retire   --release-id <32hex>                   probe + complete retirement, then stop the game project
  collect  --release-id <32hex>                   remove a confirmed retired release (project, image, aged assets)
  status                                          show registry state, snapshots and release images
  secrets                                         create canonical secret files under <state dir>/secrets
  unlock                                          remove a stale host lock (holder must be dead)`;

const commands = {
  stage: cmdStage,
  deploy: cmdDeploy,
  check: cmdCheck,
  activate: cmdActivate,
  api: cmdApi,
  retire: cmdRetire,
  collect: cmdCollect,
  status: cmdStatus,
  secrets: cmdSecrets,
  unlock: cmdUnlock,
};

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === undefined) {
    console.log(usage);
    process.exit(args.help ? 0 : 2);
  }
  const command = commands[args.command];
  if (command === undefined) {
    console.error(`Unknown command "${String(args.command)}".\n${usage}`);
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await command(args)));
  } catch (error) {
    log(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
