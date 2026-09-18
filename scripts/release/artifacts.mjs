// Protected release artifacts. Each staged release lives under
// <stateDir>/artifacts/<releaseId>/ and is immutable once snapshot.json is
// written: every later operation re-verifies file hashes and the recorded
// docker image id before acting. An existing release id is never rebuilt —
// a retry reuses the verified snapshot, so a wrong UUID can never be
// silently replaced by different bytes.
//
// A snapshot ships the app bundle, the drizzle migrations and the lockfiles;
// production dependencies are installed inside the pinned Bun image during
// `docker build`, so the container only ever runs binaries and WASM built
// for its own platform — never artifacts pruned on a foreign host.

import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { buildRelease, RELEASE_ID_PATTERN } from '../build.mjs';
import {
  distDir,
  repoDockerfile,
  repoDockerignore,
  repoDrizzleDir,
  repoRoot,
} from './constants.mjs';
import { buildImage, imageId } from './dockerx.mjs';

const SNAPSHOT_FILE = 'snapshot.json';

async function hashFile(path) {
  const bytes = await Bun.file(path).arrayBuffer();
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

async function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function measureSnapshot(dir) {
  const files = {};
  for (const path of await listFiles(dir)) {
    const name = relative(dir, path).split(sep).join('/');
    if (name !== SNAPSHOT_FILE) files[name] = await hashFile(path);
  }
  return files;
}

function snapshotEquals(measured, recorded) {
  const names = new Set([...Object.keys(measured), ...Object.keys(recorded)]);
  for (const name of names) {
    if (measured[name] !== recorded[name]) return false;
  }
  return true;
}

function snapshotDir(ctx, releaseId) {
  return join(ctx.artifactsDir, releaseId);
}

async function readSnapshot(dir) {
  const file = join(dir, SNAPSHOT_FILE);
  if (!existsSync(file)) return null;
  return JSON.parse(await Bun.file(file).text());
}

async function writeSnapshot(dir, snapshot) {
  await Bun.write(join(dir, SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** Verifies an existing snapshot byte-for-byte; refuses missing or altered artifacts. */
export async function verifySnapshot(ctx, releaseId, { log = () => {} } = {}) {
  const dir = snapshotDir(ctx, releaseId);
  const snapshot = await readSnapshot(dir);
  if (!snapshot) {
    throw new Error(
      `No protected snapshot for ${releaseId} under ${ctx.artifactsDir}. A release id is only deployable from its own staged artifact.`,
    );
  }
  if (!snapshotEquals(await measureSnapshot(dir), snapshot.files)) {
    throw new Error(
      `Protected snapshot ${dir} does not match its recorded digests. Refusing to touch a corrupted artifact.`,
    );
  }
  log(`verified snapshot ${releaseId} (artifact ${snapshot.artifactDigest})`);
  return { dir, snapshot };
}

/** Builds fresh dist/ output and freezes it into a new protected snapshot. */
export async function stageSnapshot(ctx, { releaseId, log = () => {} } = {}) {
  if (releaseId !== undefined && !RELEASE_ID_PATTERN.test(releaseId)) {
    throw new Error(`Release id must be 32 lowercase hex characters, got "${releaseId}".`);
  }
  const manifest = await buildRelease({ releaseId, log });
  const dir = snapshotDir(ctx, manifest.releaseId);
  if (existsSync(dir)) {
    throw new Error(
      `Snapshot ${dir} already exists; refusing to overwrite. Collect it explicitly if it is confirmed retired.`,
    );
  }
  await mkdir(dir, { recursive: true });
  try {
    await cp(distDir, join(dir, 'app'), { recursive: true });
    await cp(repoDrizzleDir, join(dir, 'drizzle'), { recursive: true });
    await Bun.write(
      join(dir, 'package.json'),
      await Bun.file(join(repoRoot, 'package.json')).arrayBuffer(),
    );
    await Bun.write(
      join(dir, 'bun.lock'),
      await Bun.file(join(repoRoot, 'bun.lock')).arrayBuffer(),
    );
    await Bun.write(join(dir, 'Dockerfile'), await Bun.file(repoDockerfile).arrayBuffer());
    await Bun.write(join(dir, '.dockerignore'), await Bun.file(repoDockerignore).arrayBuffer());
    await writeSnapshot(dir, {
      releaseId: manifest.releaseId,
      createdAt: new Date().toISOString(),
      artifactDigest: manifest.artifactDigest,
      files: await measureSnapshot(dir),
      image: null,
    });
    log(`staged snapshot ${manifest.releaseId}`);
    await rm(distDir, { recursive: true, force: true });
    return { dir, snapshot: await readSnapshot(dir) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Ensures the local image spelltype/release:<id> exists and matches the
 * snapshot's recorded image id. Never retags an existing tag with foreign
 * content; a missing image is rebuilt from the verified snapshot only (the
 * pinned lockfiles install inside the image), and the freshly recorded id
 * is stored as snapshot metadata — the artifact digest itself never changes.
 */
export async function ensureImage(ctx, releaseId, { log = () => {} } = {}) {
  const { dir, snapshot } = await verifySnapshot(ctx, releaseId, { log });
  const reference = `spelltype/release:${releaseId}`;
  const current = await imageId(reference);
  if (current) {
    if (!snapshot.image?.id) {
      throw new Error(
        `Image ${reference} already exists without a recorded build for snapshot ${releaseId}. Refusing to adopt unverified bytes; remove that image explicitly before rebuilding from the protected snapshot.`,
      );
    }
    if (current !== snapshot.image.id) {
      throw new Error(
        `Image ${reference} exists with content ${current} but snapshot ${releaseId} recorded ${snapshot.image.id}. Refusing to deploy mismatched bytes; remove the image explicitly if you accept the risk.`,
      );
    }
    return { reference, id: current, built: false };
  }
  const id = await buildImage(dir, reference, { log });
  snapshot.image = { reference, id, recordedAt: new Date().toISOString() };
  await writeSnapshot(dir, snapshot);
  return { reference, id, built: true };
}

/** Publishes immutable client assets into the shared collection (idempotent). */
export async function publishAssets(ctx, releaseId, { log = () => {} } = {}) {
  const { dir } = await verifySnapshot(ctx, releaseId, { log });
  const source = join(dir, 'app', 'client');
  const target = join(ctx.assetsDir, releaseId);
  if (existsSync(target)) {
    for (const path of await listFiles(source)) {
      const name = relative(source, path).split(sep).join('/');
      const existing = join(target, name);
      if (!existsSync(existing) || (await hashFile(existing)) !== (await hashFile(path))) {
        throw new Error(
          `Published assets for ${releaseId} already exist and differ from the snapshot at ${existing}. The asset collection is immutable.`,
        );
      }
    }
    log(`assets for ${releaseId} already published`);
    return target;
  }
  await cp(source, target, { recursive: true });
  log(`published assets to ${target}`);
  return target;
}
