import type { Env } from '../env';
import type { SqlStore } from '../sql';

/**
 * One matchmaker shard's view of its Durable Object instance: the bindings it calls out with, the
 * storage seam, and the single alarm — the only clock a shard has.
 */
export interface MatchmakerScope {
  readonly env: Env;
  readonly storage: DurableObjectStorage;
  readonly sql: SqlStore;
}

/** Never moves a shard's alarm later: a new deadline may only pull it forward. */
export async function armAlarm(scope: MatchmakerScope, expiry: number): Promise<void> {
  const current = await scope.storage.getAlarm();
  if (current === null || current > expiry) await scope.storage.setAlarm(expiry);
}
