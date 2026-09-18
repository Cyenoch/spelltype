// Client for the stable API's admin app (127.0.0.1:3001), consuming its
// documented JSON contract strictly: AdminReleaseState for /release and the
// mutating state views, ActivationResult for /release/activate,
// RetirementProbe for /release/retire/probe. Responses are validated with
// the same zod schemas the server side is written against; a malformed
// response fails loudly instead of being reinterpreted.

import { z } from 'zod';
import { RELEASE_ID_PATTERN } from './constants.mjs';

export class AdminError extends Error {
  constructor(status, method, path, body) {
    super(`admin ${method} ${path} -> ${status}${body ? `: ${JSON.stringify(body)}` : ''}`);
    this.name = 'AdminError';
    this.status = status;
    this.body = body;
  }
}

const REQUEST_TIMEOUT_MS = 20_000;

const hexDigest = z.string().regex(/^[0-9a-f]{64}$/);
const releaseId = z.string().regex(RELEASE_ID_PATTERN);

const stateSchema = z.enum(['staged', 'active', 'retiring', 'retired']);

const versionViewSchema = z
  .object({
    releaseId,
    state: stateSchema,
    artifactDigest: hexDigest,
    operationId: z.string(),
    admissionEpoch: z.number().int().min(0),
    runtimeId: z.string().nullable(),
    runtimeEpoch: z.number().int().min(0),
    leaseUntil: z.number().nullable(),
    checkedEpoch: z.number().int().min(0).nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    retiredAt: z.number().nullable(),
  })
  .strict();

const releaseStateSchema = z
  .object({
    releaseId,
    control: z
      .object({
        activeReleaseId: releaseId.nullable(),
        revision: z.number().int().min(0),
        updatedAt: z.number(),
      })
      .strict(),
    versions: z.array(versionViewSchema),
  })
  .strict();

const releaseInfoSchema = z
  .object({
    activeReleaseId: releaseId.nullable(),
    updatedAt: z.number(),
  })
  .strict();

const activationResultSchema = z
  .object({
    info: releaseInfoSchema,
    previousReleaseId: releaseId.nullable(),
  })
  .strict();

const retirementProbeSchema = z
  .object({
    releaseId,
    state: stateSchema,
    admissionEpoch: z.number().int().min(0),
    activeMatches: z.number().int().min(0),
    liveReservations: z.number().int().min(0),
    waitingTickets: z.number().int().min(0),
    liveMatchedTickets: z.number().int().min(0),
    pendingResults: z.number().int().min(0),
    runtimeKnown: z.boolean(),
    ready: z.boolean(),
  })
  .strict();

async function parseResponse(schema, method, path, response) {
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    throw new AdminError(response.status, method, path, 'non-JSON response body');
  }
  if (!response.ok) throw new AdminError(response.status, method, path, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AdminError(
      response.status,
      method,
      path,
      `malformed response: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

async function call(ctx, schema, method, path, body) {
  if (!ctx.token) throw new Error('Admin token is required for registry operations.');
  let response;
  try {
    const headers = new Headers({ authorization: `Bearer ${ctx.token}` });
    /** @type {RequestInit} */
    const options = {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    };
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      options.body = JSON.stringify(body);
    }
    response = await fetch(new URL(path, ctx.adminUrl), options);
  } catch (error) {
    if (error.name === 'TimeoutError') throw new AdminError(0, method, path, 'request timed out');
    throw new AdminError(
      0,
      method,
      path,
      `unreachable (${error.message}). Is the base stack up? docker compose --env-file deploy/compose.env -p spelltype up -d`,
    );
  }
  return parseResponse(schema, method, path, response);
}

export const getReleaseState = (ctx) => call(ctx, releaseStateSchema, 'GET', '/release');
export const adminHealth = async (ctx) => {
  const response = await fetch(new URL('/health', ctx.adminUrl), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return parseResponse(z.object({ ok: z.literal(true) }).strict(), 'GET', '/health', response);
};
export const stageRelease = (ctx, body) =>
  call(ctx, releaseStateSchema, 'POST', '/release/stage', body);
export const checkRelease = (ctx, body) =>
  call(ctx, versionViewSchema, 'POST', '/release/check', body);
export const activateRelease = (ctx, body) =>
  call(ctx, activationResultSchema, 'POST', '/release/activate', body);
export const probeRetirement = (ctx, releaseId) =>
  call(ctx, retirementProbeSchema, 'POST', '/release/retire/probe', { releaseId });
export const completeRetirement = (ctx, body) =>
  call(ctx, releaseStateSchema, 'POST', '/release/retire/complete', body);

/** Strict views over the validated shapes — no fallbacks, no aliases. */
export function controlActiveReleaseId(state) {
  return state.control.activeReleaseId;
}

export function versionEntry(state, releaseId) {
  return state.versions.find((entry) => entry.releaseId === releaseId) ?? null;
}

export function versionState(state, releaseId) {
  return versionEntry(state, releaseId)?.state ?? null;
}
