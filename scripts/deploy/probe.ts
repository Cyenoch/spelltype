// Public endpoint probes used as deployment proof. There is no admin
// listener and no bearer token: the only HTTP facts the runner trusts are the
// public /health (live runtime lease + database, proves build identity and
// the runtime epoch needed to resume) and /api/status (maintenance pointer,
// protocol and build identity).

import { z } from 'zod';
import { serviceStatusSchema, type ServiceStatus } from '../../shared/maintenance';

const REQUEST_TIMEOUT_MS = 10_000;

// /health has no shared business schema (it is a deployment proof); the local
// parse keeps the boundary honest without inventing parallel domain types.
const runtimeHealthSchema = z.object({
  ok: z.literal(true),
  buildId: z.string().min(1),
  protocolVersion: z.string().min(1),
  runtimeEpoch: z.number(),
});

export interface RuntimeHealth extends z.infer<typeof runtimeHealthSchema> {}

export class ProbeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ProbeError';
  }
}

interface ProbeTarget {
  appBaseUrl: string;
}

async function getJson(target: ProbeTarget, path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${target.appBaseUrl}${path}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProbeError(
      0,
      `${target.appBaseUrl}${path} unreachable (${error instanceof Error ? error.message : String(error)}); is the app container running?`,
    );
  }
  if (!response.ok) {
    throw new ProbeError(response.status, `${path} returned ${response.status}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ProbeError(response.status, `${path} returned a non-JSON body`);
  }
}

/** GET /api/status on the public listener (maintenance pointer + identity). */
export async function getServiceStatus(target: ProbeTarget): Promise<ServiceStatus> {
  return serviceStatusSchema.parse(await getJson(target, '/api/status'));
}

/**
 * GET /health on the public listener: 200 only while the live runtime lease
 * and the database are reachable — including during maintenance draining.
 * The returned runtimeEpoch is the lease proof the runner passes to the
 * maintenance entry when resuming admission.
 */
export async function getRuntimeHealth(target: ProbeTarget): Promise<RuntimeHealth> {
  return runtimeHealthSchema.parse(await getJson(target, '/health'));
}
