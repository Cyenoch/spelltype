import { HTTPException } from 'hono/http-exception';
import type { ServerServices } from '../contracts';
import { deleteSession, planSessionRevocation, type SessionSeat } from '../auth/sessions';

/**
 * The admin endpoint a game container exposes for another process's logout to close its sockets.
 * Ports follow the deployment contract: game public 3000, admin 3001, deterministic per release.
 */
function gameAdminOrigin(releaseId: string): string {
  return `http://game-${releaseId}:3001`;
}

/** The exact fetch shape logout fan-out uses; tests inject a fake through `revokeSessionEverywhere`. */
export type RevokeFetch = typeof fetch;

/** The one refusal a logout reports while any release runtime declines to confirm closure. */
const REVOCATION_REFUSAL = new HTTPException(503, { message: '退出失败，请重试' });

async function revokeOnRelease(
  services: ServerServices,
  releaseId: string,
  tokenHash: string,
  revokeFetch: RevokeFetch,
): Promise<void> {
  const { config, rooms } = services;
  if (rooms && (config.role === 'all' || releaseId === config.releaseId)) {
    await rooms.revokeSession(tokenHash);
    return;
  }
  if (!config.adminToken) throw REVOCATION_REFUSAL;
  const response = await revokeFetch(`${gameAdminOrigin(releaseId)}/sessions/revoke`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.adminToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tokenHash }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw REVOCATION_REFUSAL;
}

/**
 * Truthful multi-release logout.
 *
 * The session is tombstoned and its remaining seats read in one transaction; every release whose
 * rooms still hold one of those seats must then acknowledge that this session's sockets are closed
 * — the in-process runtime for this deployment's own release, the per-release game containers'
 * admin endpoints otherwise (a retirement only ever completes with zero live seats, so retired
 * releases never appear here). A single refusal throws 503, so the caller can never report a
 * logout while a socket of that session is still connected; the tombstone plus the untouched seat
 * rows remain as the retry target. Only once every runtime has acknowledged is the session deleted,
 * and the foreign keys cascade the seat rows away with it.
 */
export async function revokeSessionEverywhere(
  services: ServerServices,
  tokenHash: string,
  revokeFetch: RevokeFetch = fetch,
): Promise<void> {
  const seats: SessionSeat[] = await planSessionRevocation(services.database, tokenHash);
  const releases = new Set<string>();
  for (const seat of seats) releases.add(seat.releaseId);
  await Promise.all(
    [...releases].map((releaseId) => revokeOnRelease(services, releaseId, tokenHash, revokeFetch)),
  );
  await deleteSession(services.database, tokenHash);
}
