// Produces the standard dist/ payload baked into the application image:
//
//   dist/client/            Vite frontend output, served from `/`
//   dist/server/index.js    Bun bundle of server/index.ts (app entry)
//   dist/server/migrate.js  Bun bundle of server/migrate.ts (one-shot migration entry)
//
// The build identity is SPELLTYPE_BUILD_ID when the environment pins it (the
// Dockerfile passes the BUILD_ID build arg this way), otherwise it is
// generated once per invocation. It is informational only: it is compiled in
// as the __SPELLTYPE_BUILD_ID__ macro and reported by /health and /api/status
// so an operator can prove which build a container runs. It is never used for
// routing or authorization, and there is no release manifest.
//
// A failed build leaves no dist/ behind, so a half-built tree can never
// become a deployment candidate.
//
// Run with the Bun runtime: bun scripts/build.mjs

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
 * Builds the deployable dist/ tree. Returns { buildId }.
 * Throws after removing dist/ when any step fails.
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
      // The compiled server entries carry the build identity reported by
      // /health and /api/status; the deploy CLI proves the candidate's
      // identity with `--check` entries before draining.
      define: { __SPELLTYPE_BUILD_ID__: JSON.stringify(buildId) },
      external: await runtimeExternals(),
    });
    if (!serverBundle.success) {
      for (const entry of serverBundle.logs) log(String(entry));
      throw new Error('Bun.build failed for the server entries');
    }
    // The host-side maintenance entry compiles to a fixed output name
    // (dist/server/maintenance.js) regardless of its source file name.
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
