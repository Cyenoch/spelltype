import { z } from 'zod';

/**
 * The maintenance contract shared by the server, the admin tooling and the client — schemas
 * first, so every consumer validates the same wire shape instead of hand-rolling one.
 *
 * Maintenance is one global, durable database state — not a per-room or per-release flag. The
 * `runtime_control` row owns `mode`; `revision` is the CAS token every state change must quote;
 * `updatedAt` is wall-clock milliseconds of the last committed change. Everything else in this
 * module is derived observation: drain counts, runtime lease knowledge, readiness.
 *
 * There is deliberately no build identity in the business protocol — `ServiceStatus` carries
 * `buildId` purely as information for humans and deploy tooling.
 */

export const maintenanceModeSchema = z.enum(['open', 'draining']);

/** `open`: the server admits new rooms and new queue tickets. `draining`: it does not. */
export type MaintenanceMode = z.infer<typeof maintenanceModeSchema>;

export const maintenanceInfoSchema = z.object({
  mode: maintenanceModeSchema,
  /** Bumped on every committed transition; callers CAS against it. */
  revision: z.number().int(),
  /** Wall-clock milliseconds of the last committed transition. */
  updatedAt: z.number().int(),
});

/** The durable, authoritative maintenance pointer as stored in `runtime_control`. */
export type MaintenanceInfo = z.infer<typeof maintenanceInfoSchema>;

export const drainStatusSchema = maintenanceInfoSchema.extend({
  /** Rooms in `generating`/`countdown`/`playing`: matches still being played. */
  activeMatches: z.number().int(),
  /** Quick-match seats whose reservation TTL is still live. */
  liveReservations: z.number().int(),
  /** Queue tickets still waiting for a partner (admission deletes these on entering). */
  waitingTickets: z.number().int(),
  /** Finished rooms whose result bookkeeping is still `saving` or `error`. */
  pendingResults: z.number().int(),
  /** False when a lease lapsed without graceful release: the runtime's state is unknown. */
  runtimeKnown: z.boolean(),
  /** The current runtime ownership generation on the control row. */
  runtimeEpoch: z.number().int(),
  /** Draining ∧ no blockers ∧ runtime state known. */
  ready: z.boolean(),
});

/**
 * What still blocks reopening, counted under the control-row lock. `ready` is true only while
 * draining with zero blocking work and a runtime state the database can vouch for.
 */
export type DrainStatus = z.infer<typeof drainStatusSchema>;

export const serviceStatusSchema = z.object({
  maintenance: maintenanceInfoSchema,
  protocolVersion: z.string(),
  /** Informational build identity; never used for authorization or routing. */
  buildId: z.string(),
});

/** The public status document served by `GET /api/status`. */
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

const messages = {
  'maintenance:draining': '服务器维护中，新的对局暂时无法开始，进行中的对局不受影响。',
  'maintenance:unavailable': '服务状态暂不可用，请稍后重试。',
} as const;

export type MaintenanceCode = keyof typeof messages;

/**
 * Refusal to start new work because the service is draining (or its state cannot be proven).
 * Always 503: the situation is the deployment's deliberate choice or a fail-closed unknown, and
 * the client should retry later rather than treat the request as invalid.
 */
export class MaintenanceError extends Error {
  readonly status = 503;

  constructor(readonly code: MaintenanceCode) {
    super(messages[code]);
    this.name = 'MaintenanceError';
  }
}
