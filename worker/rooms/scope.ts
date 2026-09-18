import type { Env } from '../env';
import { INPUTS_PER_SECOND } from './rules';
import type { SqlStore } from '../sql';

/**
 * The room's per-connection input quota. It is deliberately memory-only: a burst is a property of one
 * live socket, and a restart may reset it without changing any decision the persisted match depends on.
 */
export class InputBudget {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  /** Accepts a packet, or refuses it once this connection has spent its second's quota. */
  allow(connId: string, now: number): boolean {
    const window = this.windows.get(connId);
    if (!window || now - window.startedAt >= 1_000) {
      this.windows.set(connId, { startedAt: now, count: 1 });
      return true;
    }
    if (window.count >= INPUTS_PER_SECOND) return false;
    window.count++;
    return true;
  }

  /** Forgets one connection: a closed, replaced or revoked socket has no quota left to spend. */
  release(connId: string): void {
    this.windows.delete(connId);
  }
}

/**
 * Everything the room's domain modules need from the Durable Object instance: its database, its
 * bindings, its live sockets and its per-connection quota. Passing it explicitly keeps the domain
 * free of the class, while `GameRoom` stays the only place that talks to the platform.
 */
export interface RoomScope {
  readonly env: Env;
  readonly sql: SqlStore;
  readonly input: InputBudget;
  /** The room's single alarm: the only clock it has. */
  readonly alarm: {
    set(when: number): Promise<void>;
    clear(): Promise<void>;
  };
  /**
   * Runs `callback` inside one synchronous storage transaction: either every SQL write it makes
   * commits together or none of it does, and an exception leaves the database exactly as it was.
   * There is no await inside — network, alarms and snapshot sends stay outside the boundary.
   */
  transactionSync<T>(callback: () => T): T;
  /** The sockets this instance owns at this instant: the only ones allowed to receive room state. */
  sockets(): WebSocket[];
}
