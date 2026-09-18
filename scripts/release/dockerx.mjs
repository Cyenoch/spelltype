// The only place that touches docker. Every invocation is a spawned CLI call
// with a deterministic argument list; container secrets live in compose
// files, never in argv or logs.

import { composeFile, releaseComposeFile } from './constants.mjs';

export class DockerError extends Error {
  constructor(command, code, stderr) {
    super(`docker ${command.join(' ')} failed (exit ${code}): ${stderr || 'no stderr'}`);
    this.name = 'DockerError';
  }
}

async function run(args, { env } = {}) {
  const child = Bun.spawn(['docker', ...args], {
    env: env ? { ...process.env, ...env } : process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function docker(args, options = {}) {
  const result = await run(args, options);
  if (result.code !== 0) throw new DockerError(args, result.code, result.stderr);
  return result.stdout;
}

export async function dockerMaybe(args, options = {}) {
  const result = await run(args, options);
  return result.code === 0 ? result.stdout : null;
}

/** docker compose for the base stack; interpolation comes from the context env. */
export function baseCompose(project, args, options = {}) {
  return docker(['compose', '-p', project, '-f', composeFile, ...args], options);
}

/**
 * docker compose for one per-release game project. The release compose file
 * is pinned here so a per-game stop/down can never fall through to the base
 * stack's compose.yaml (wrong config, wrong network); env is pre-merged
 * gameComposeEnv output.
 */
export function gameCompose(project, args, options = {}) {
  return docker(['compose', '-p', project, '-f', releaseComposeFile, ...args], options);
}

export async function imageId(reference) {
  return dockerMaybe(['image', 'inspect', '--format', '{{.Id}}', reference]);
}

export async function buildImage(snapshotDir, reference, { log = () => {} } = {}) {
  log(`building image ${reference}`);
  await docker([
    'build',
    '--no-cache',
    '-f',
    `${snapshotDir}/Dockerfile`,
    '-t',
    reference,
    snapshotDir,
  ]);
  const id = await imageId(reference);
  if (!id) throw new Error(`Image ${reference} disappeared immediately after build.`);
  return id;
}

export async function tagImage(reference, target) {
  await docker(['image', 'tag', reference, target]);
}

export async function removeImage(reference) {
  return dockerMaybe(['image', 'rm', '-f', reference]) !== null;
}
