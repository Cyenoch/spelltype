// Produces one immutable release build under dist/:
//
//   dist/release.json       { releaseId, createdAt, artifactDigest }
//   dist/server/index.js    Bun bundle of server/index.ts (runtime deps external)
//   dist/client/            Vite frontend output, base /_releases/<releaseId>/
//
// The release identity is SPELLTYPE_RELEASE_ID (32 lowercase hex) when the
// environment pins it, otherwise it is generated exactly once per build. A
// failed build leaves no dist/ behind, so a half-built release can never be
// staged or deployed. `bun scripts/build.mjs` runs standalone; the release
// CLI imports buildRelease() to stage protected artifact snapshots.
//
// Run with the Bun runtime: bun scripts/build.mjs

import { randomBytes } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_ID_PATTERN = /^[0-9a-f]{32}$/;

const root = fileURLToPath(new URL('../', import.meta.url));
const distDir = join(root, 'dist');
const clientDir = join(distDir, 'client');
const serverDir = join(distDir, 'server');
const serverBundle = join(serverDir, 'index.js');

async function runtimeExternals() {
  const pkg = await Bun.file(join(root, 'package.json')).json();
  return Object.keys(pkg.dependencies ?? {});
}

async function hashFile(path) {
  const bytes = await Bun.file(path).arrayBuffer();
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

async function listFiles(dir) {
  const files = [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function treeDigest(paths, base) {
  const files = {};
  for (const path of paths.sort()) {
    files[relative(base, path).split(sep).join('/')] = await hashFile(path);
  }
  return files;
}

/**
 * Builds one release into dist/. Returns { releaseId, artifactDigest, files }.
 * Throws after removing dist/ when any step fails.
 */
export async function buildRelease({ releaseId, log = () => {} } = {}) {
  if (releaseId !== undefined && !RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error(`Release id must match ${RELEASE_ID_PATTERN}, got "${releaseId}".`);
  }
  const identity = releaseId ?? randomBytes(16).toString('hex');
  await rm(distDir, { recursive: true, force: true });

  try {
    log(`building frontend for release ${identity}`);
    const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
    const child = Bun.spawn(
      [process.execPath, vite, 'build', '--outDir', 'dist/client', '--emptyOutDir'],
      {
        cwd: root,
        env: { ...process.env, SPELLTYPE_RELEASE_ID: identity },
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    );
    const frontend = await child.exited;
    if (frontend !== 0) throw new Error(`vite build failed with exit code ${frontend}`);

    log('bundling server with Bun.build');
    const bundled = await Bun.build({
      entrypoints: [join(root, 'server', 'index.ts')],
      outdir: serverDir,
      naming: 'index.js',
      target: 'bun',
      format: 'esm',
      splitting: false,
      sourcemap: 'none',
      // The compiled server carries the same identity as the browser bundle
      // and dist/release.json; production config cross-checks all three so a
      // manifest can never relabel one build's code as another release.
      define: { __SPELLTYPE_RELEASE_ID__: JSON.stringify(identity) },
      external: await runtimeExternals(),
    });
    if (!bundled.success) {
      for (const entry of bundled.logs) log(String(entry));
      throw new Error('Bun.build failed for server/index.ts');
    }

    const files = await treeDigest([...(await listFiles(clientDir)), serverBundle], distDir);
    const artifactDigest = new Bun.CryptoHasher('sha256')
      .update(JSON.stringify({ releaseId: identity, files }))
      .digest('hex');
    const manifest = { releaseId: identity, createdAt: new Date().toISOString(), artifactDigest };
    await Bun.write(join(distDir, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    log(`release ${identity} ready (artifact ${artifactDigest})`);
    return { ...manifest, files };
  } catch (error) {
    await rm(distDir, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const manifest = await buildRelease({
    releaseId: process.env.SPELLTYPE_RELEASE_ID?.trim(),
    log: console.error,
  });
  console.log(
    JSON.stringify({ releaseId: manifest.releaseId, artifactDigest: manifest.artifactDigest }),
  );
}
