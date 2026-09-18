import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifySnapshot } from '../../scripts/release/artifacts.mjs';

const releaseId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const bundle = 'export const release = "immutable";\n';
const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function protectedArtifact() {
  const artifactsDir = await mkdtemp(join(tmpdir(), 'spelltype-artifact-'));
  roots.push(artifactsDir);
  const dir = join(artifactsDir, releaseId);
  await mkdir(join(dir, 'app'), { recursive: true });
  await Bun.write(join(dir, 'app', 'bundle.js'), bundle);
  const snapshot = {
    releaseId,
    artifactDigest: new Bun.CryptoHasher('sha256').update(bundle).digest('hex'),
    files: { 'app/bundle.js': new Bun.CryptoHasher('sha256').update(bundle).digest('hex') },
    image: null,
  };
  await Bun.write(join(dir, 'snapshot.json'), JSON.stringify(snapshot));
  return { ctx: { artifactsDir }, dir, snapshot };
}

test('a staged artifact remains deployable after recording its image metadata', async () => {
  const { ctx, dir, snapshot } = await protectedArtifact();
  const staged = await verifySnapshot(ctx, releaseId);
  expect(await Bun.file(join(staged.dir, 'app', 'bundle.js')).text()).toBe(bundle);

  snapshot.image = { id: `sha256:${'b'.repeat(64)}`, reference: `spelltype/release:${releaseId}` };
  await Bun.write(join(dir, 'snapshot.json'), JSON.stringify(snapshot));
  const recorded = await verifySnapshot(ctx, releaseId);
  expect(await Bun.file(join(recorded.dir, 'app', 'bundle.js')).text()).toBe(bundle);
});

test.each(['changed', 'missing', 'unrecorded'])('refuses %s artifact bytes', async (mutation) => {
  const { ctx, dir } = await protectedArtifact();
  const file = join(dir, 'app', 'bundle.js');
  if (mutation === 'changed') await Bun.write(file, 'different executable bytes');
  else if (mutation === 'missing') await rm(file);
  else await Bun.write(join(dir, 'app', 'unexpected.js'), 'unrecorded executable bytes');
  await expect(verifySnapshot(ctx, releaseId)).rejects.toThrow();
});
