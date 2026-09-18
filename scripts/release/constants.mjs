// Fixed layout of the host-side release tooling. Every environment knob
// (state dir, base project, network, ports) resolves through
// scripts/release/env.mjs — this module only fixes paths of checked-in
// deployment assets and naming formats.

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const composeFile = join(repoRoot, 'compose.yaml');
export const releaseComposeFile = join(repoRoot, 'compose.release.yaml');
export const composeEnvFile = join(repoRoot, 'deploy', 'compose.env');
export const repoDockerfile = join(repoRoot, 'Dockerfile');
export const repoDockerignore = join(repoRoot, '.dockerignore');
export const repoDrizzleDir = join(repoRoot, 'drizzle');
export const distDir = join(repoRoot, 'dist');

export const IMAGE_REPO = 'spelltype/release';
export const RELEASE_ID_PATTERN = /^[0-9a-f]{32}$/;
export const ADMIN_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
export const COMPOSE_PROJECT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const imageRef = (releaseId) => `${IMAGE_REPO}:${releaseId}`;
