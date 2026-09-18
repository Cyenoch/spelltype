// Bounded, explicit, safe collection policy. Nothing here ever prunes
// globally: exactly one operator-selected release is examined, and it is
// only touched when the registry confirms it retired. The two newest
// releases stay collectible-proof so rollback stays possible; immutable
// assets younger than seven days are retained even for retired releases.

import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { versionEntry } from './registry.mjs';

export const RETAINED_RELEASES = 2;
export const ASSET_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ARTIFACT_SNAPSHOTS = 6;

export async function guardSnapshotCapacity(ctx) {
  const entries = await readdir(ctx.artifactsDir).catch(() => []);
  if (entries.length >= MAX_ARTIFACT_SNAPSHOTS) {
    throw new Error(
      `Artifact store ${ctx.artifactsDir} holds ${entries.length} snapshots (limit ${MAX_ARTIFACT_SNAPSHOTS}). Collect a confirmed retired release first: bun run deploy collect --release-id <id>`,
    );
  }
}

async function localSnapshots(ctx) {
  const entries = await readdir(ctx.artifactsDir).catch(() => []);
  const snapshots = [];
  for (const name of entries) {
    const file = join(ctx.artifactsDir, name, 'snapshot.json');
    if (!existsSync(file)) continue;
    const snapshot = JSON.parse(await Bun.file(file).text());
    snapshots.push({ releaseId: snapshot.releaseId ?? name, snapshot });
  }
  return snapshots;
}

async function snapshotCreatedAtMs(entry) {
  const value = entry?.snapshot?.createdAt;
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decides what may be removed for one explicitly selected release.
 * Fails closed on unknown registry ids, non-retired states and releases
 * inside the two-newest retention window.
 */
export async function collectPlan(ctx, state, releaseId, { now = Date.now() } = {}) {
  const version = versionEntry(state, releaseId);
  if (!version) {
    throw new Error(
      `Registry has no release ${releaseId}; refusing to collect an unknown release.`,
    );
  }
  if (version.state !== 'retired') {
    throw new Error(
      `Release ${releaseId} is "${version.state}"; only confirmed retired releases can be collected. Probe and complete retirement first.`,
    );
  }

  const newest = state.versions.map((entry) => ({
    releaseId: entry.releaseId,
    at: entry.createdAt,
  }));
  for (const local of await localSnapshots(ctx)) {
    if (!newest.some((row) => row.releaseId === local.releaseId)) {
      newest.push({ releaseId: local.releaseId, at: await snapshotCreatedAtMs(local) });
    }
  }
  newest.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const retentionWindow = new Set(newest.slice(0, RETAINED_RELEASES).map((row) => row.releaseId));

  const plan = {
    releaseId,
    downProject: true,
    removeImage: true,
    removeSnapshot: true,
    removeAssets: null,
    keepReasons: [],
  };
  if (retentionWindow.has(releaseId)) {
    throw new Error(
      `Release ${releaseId} is one of the ${RETAINED_RELEASES} newest releases and is kept for rollback. Collect an older release or deploy a newer one first.`,
    );
  }
  if (now - version.createdAt < ASSET_MIN_AGE_MS) {
    plan.removeAssets = false;
    plan.keepReasons.push('immutable assets are retained for at least 7 days');
  } else {
    plan.removeAssets = true;
  }
  return plan;
}

export async function removeAssetsDir(ctx, releaseId) {
  const dir = join(ctx.assetsDir, releaseId);
  if (!existsSync(dir)) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

export async function removeSnapshotDir(ctx, releaseId) {
  const dir = join(ctx.artifactsDir, releaseId);
  if (!existsSync(dir)) return false;
  await stat(dir);
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** Lists snapshot dirs that never completed staging (no snapshot.json). */
export async function incompleteSnapshots(ctx) {
  const entries = await readdir(ctx.artifactsDir).catch(() => []);
  const incomplete = [];
  for (const name of entries) {
    if (!existsSync(join(ctx.artifactsDir, name, 'snapshot.json'))) incomplete.push(name);
  }
  return incomplete;
}
