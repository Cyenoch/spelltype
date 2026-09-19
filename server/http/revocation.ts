import { HTTPException } from 'hono/http-exception';
import type { ServerServices } from '../contracts';
import { deleteSession, tombstoneSession } from '../auth/sessions';

/** A failed closure leaves the tombstone and cookie available for a truthful retry. */
export async function revokeSession(services: ServerServices, tokenHash: string): Promise<void> {
  await tombstoneSession(services.database, tokenHash);
  const runtime = services.rooms;
  if (!runtime) throw new HTTPException(503, { message: '退出失败，请重试' });
  try {
    await runtime.revokeSession(tokenHash);
    // A replaced process cannot acknowledge closure on behalf of its successor.
    await services.database.transaction((tx) => runtime.assertOwnership(tx));
  } catch {
    throw new HTTPException(503, { message: '退出失败，请重试' });
  }
  await deleteSession(services.database, tokenHash);
}
