// Remote maintenance transport: the bearer-only machine API at
// /api/ops/maintenance on the normal app listener (no admin port, no cookie
// auth). Intended for CI/platform automation that drains and resumes around a
// container replacement ITSELF performs — this API never touches containers.
// The token reaches the CLI only through environment or file configuration;
// it is never accepted on the command line and never logged.

import {
  drainStatusSchema,
  maintenanceInfoSchema,
  type DrainStatus,
  type MaintenanceInfo,
} from '../../shared/maintenance';

const REQUEST_TIMEOUT_MS = 10_000;

export class MaintenanceConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaintenanceConflictError';
  }
}

export class OpsError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpsError';
  }
}

export interface OpsClient {
  baseUrl: string;
  token: string;
}

function detailFrom(payload: unknown): string {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = payload.error;
    if (typeof error === 'string' && error.length > 0) return error;
  }
  return '(no detail)';
}

async function opsFetch(client: OpsClient, method: string, body?: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${client.baseUrl}/api/ops/maintenance`, {
      method,
      headers: {
        authorization: `Bearer ${client.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new OpsError(
      0,
      `${client.baseUrl}/api/ops/maintenance unreachable (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  let payload: unknown;
  const text = await response.text();
  if (text.length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = undefined;
    }
  }
  if (!response.ok) {
    const detail = detailFrom(payload);
    if (response.status === 409) {
      throw new MaintenanceConflictError(`maintenance CAS conflict: ${detail}`);
    }
    throw new OpsError(response.status, `ops ${method} failed (${response.status}): ${detail}`);
  }
  return payload;
}

/** GET /api/ops/maintenance — full DrainStatus (counts, runtime epoch, ready). */
export async function opsDrainStatus(client: OpsClient): Promise<DrainStatus> {
  return drainStatusSchema.parse(await opsFetch(client, 'GET'));
}

/** POST {mode:'draining', expectedRevision} — durable drain CAS. */
export async function opsDrain(
  client: OpsClient,
  expectedRevision: number,
): Promise<MaintenanceInfo> {
  return maintenanceInfoSchema.parse(
    await opsFetch(client, 'POST', { mode: 'draining', expectedRevision }),
  );
}

/**
 * POST {mode:'open', expectedRevision, expectedRuntimeEpoch} — the server
 * verifies the epoch against its current handler runtime and the DB lease
 * before reopening admission.
 */
export async function opsResume(
  client: OpsClient,
  expectedRevision: number,
  expectedRuntimeEpoch: number,
): Promise<MaintenanceInfo> {
  return maintenanceInfoSchema.parse(
    await opsFetch(client, 'POST', {
      mode: 'open',
      expectedRevision,
      expectedRuntimeEpoch,
    }),
  );
}
