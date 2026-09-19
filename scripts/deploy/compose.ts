// docker compose driver. Every invocation is scoped to the resolved project
// name, the resolved COMPOSE_FILE set and deploy/compose.env, so the CLI and
// the operator always manipulate the exact same stack — including override
// layers such as deploy/compose.dokploy.yaml routing. Deploy-level overrides
// (the pinned image) are injected through the process environment, which
// compose interpolation prefers over env files.

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

/** Runs docker compose with the CLI's canonical project/file/env arguments. */
export async function compose(
  ctx: DeployContext,
  args: string[],
  options: { imageId?: string } = {},
): Promise<SpawnRun> {
  return runCompose(ctx, args, options.imageId, { capture: true });
}

/**
 * Every docker compose command interpolates the whole file model, so
 * SPELLTYPE_APP_IMAGE must always be set even for commands that never create
 * an app/migrate container (ps, stop, inspect). Commands that DO create
 * containers always receive the real pinned imageId explicitly.
 */
function childComposeEnv(imageId: string | undefined): Record<string, string | undefined> {
  const childEnv: Record<string, string | undefined> = { ...process.env };
  // COMPOSE_FILE is removed: the resolved set is passed as explicit --file
  // flags, and the two must never disagree.
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

/** Runs docker compose, inheriting stdio (progress visible), throwing on failure. */
async function composeInherit(ctx: DeployContext, args: string[], imageId?: string): Promise<void> {
  await runCompose(ctx, args, imageId, { capture: false });
}

/** Resolves an image reference to its exact immutable ID. */
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
 * Proves both server entries are executable in the candidate and reads the
 * compiled build identity — before any maintenance happens, so a broken
 * candidate can never close the service. Both bundles must agree on the
 * identity: one image, one build.
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

/** Refuses ambiguous or failed inspection rather than mistaking it for an absent app. */
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

/** Recreates the app container pinned to one exact image ID, no dependencies. */
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

/** Ensures the database service is up and passing its healthcheck. */
export async function ensureDatabase(ctx: DeployContext): Promise<void> {
  log('ensuring the database is up');
  await composeInherit(ctx, ['up', '-d', '--wait', '--wait-timeout', '120', 'database']);
}

/**
 * Runs the one-shot migration with the pinned candidate image. Never runs
 * concurrently with an app container; the caller guarantees the ordering.
 */
export async function runMigrate(ctx: DeployContext, imageId: string): Promise<void> {
  log('applying the one-shot forward migration');
  await composeInherit(ctx, ['run', '--rm', 'migrate'], imageId);
}

/** Builds the candidate image from the repository checkout. */
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
