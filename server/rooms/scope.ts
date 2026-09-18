import type { RoomSocket, GenerateSpells } from '../contracts';
import type { QueryDatabase, Transaction } from '../db';
import type { InputPolicyMode } from '../../shared/protocol';
import { pushSnapshots } from './snapshots';
import { INPUTS_PER_SECOND } from './rules';

/**
 * The immutable admission rules a runtime hands its rooms. Both are validated at
 * startup; the room only ever reads the typed value and refuses to open a match
 * when the runtime was not configured for one.
 */
export interface RoomMatchPolicy {
  /** Global admission: only `open` starts new matches; `draining` pauses them. */
  readonly matchAdmission: 'open' | 'draining';
  /** The input-time mode every match this runtime opens locks into its room row. */
  readonly inputPolicyMode: InputPolicyMode;
}

/** The identity a socket was accepted with, fixed once at connect time. */
export type SocketAuth = {
  userId: string;
  username: string;
  connId: string;
  sessionHash: string;
  sessionExpires: number;
  /** The wire protocol accepted by this connection's native upgrade. */
  protocolVersion: string;
};

/**
 * The room's own socket registry. Bun's server sockets carry no per-socket
 * listener surface, so the engine tracks attachments here — keyed by socket
 * object identity. No socket or attachment survives a process restart.
 */
export class SocketRegistry {
  private readonly entries = new Map<RoomSocket, SocketAuth>();

  /** Records one accepted socket's authority. */
  attach(socket: RoomSocket, auth: SocketAuth): void {
    this.entries.set(socket, auth);
  }

  /** Forgets a socket; returns the identity it carried, if any. */
  detach(socket: RoomSocket): SocketAuth | undefined {
    const auth = this.entries.get(socket);
    this.entries.delete(socket);
    return auth;
  }

  /** The identity a socket was accepted with, or `null` for anything unknown. */
  metaOf(socket: RoomSocket): SocketAuth | null {
    return this.entries.get(socket) ?? null;
  }

  /** Every socket this room currently tracks, open or not. */
  list(): RoomSocket[] {
    return [...this.entries.keys()];
  }
}

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
 * Everything the room's domain modules need: the room's identity, its database (or the transaction
 * of the command currently running), its live sockets and its per-connection quota. Passing it
 * explicitly keeps the domain free of the engine, while the engine stays the only place that owns
 * serialization, timers and socket lifecycle.
 */
export interface RoomScope {
  readonly roomId: string;
  readonly releaseId: string;
  /** Plain (non-transactional) database access; command transactions flow through `transact`. */
  readonly db: QueryDatabase;
  readonly generate: GenerateSpells;
  readonly input: InputBudget;
  readonly registry: SocketRegistry;
  /** The admission rules this runtime was started with; match opening reads them. */
  readonly matchAdmission: 'open' | 'draining';
  readonly inputPolicyMode: InputPolicyMode;
  /**
   * The generation attempt this engine is currently awaiting, if any. The
   * engine's own bookkeeping must never treat its local, in-flight attempt as
   * a crashed one — only a claim no live continuation owns is interrupted.
   */
  inFlightGeneration: string | null;
  now(): number;
  /** One fenced mutation transaction: ownership asserted under row lock before the body runs. */
  transact<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Publishes per-seat snapshots from committed state to every authorized socket. */
  push(): Promise<void>;
  /** Recomputes the room's earliest durable deadline and rearms the runtime timer. */
  arm(): Promise<void>;
}

export interface RoomScopeOptions {
  roomId: string;
  releaseId: string;
  db: QueryDatabase;
  generate: GenerateSpells;
  registry: SocketRegistry;
  /** The runtime's admission rules; mandatory, so a scope can never guess them. */
  matchAdmission: 'open' | 'draining';
  inputPolicyMode: InputPolicyMode;
  /** The engine's quota tracker; when omitted the scope owns a fresh one. */
  input?: InputBudget;
  /** Defaults to running the body against the plain database (autocommit) — the unit-test seam. */
  transact?<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Defaults to a real snapshot fan-out over the registry. */
  push?(scope: RoomScope): Promise<void> | void;
  /** Defaults to a no-op — only the live engine owns timers. */
  arm?(scope: RoomScope): Promise<void> | void;
}

/**
 * Builds one room's scope. The live engine supplies its own fenced `transact`,
 * snapshot fan-out and timer arming; tests drive the domain directly with the
 * defaults, which keeps the production paths the only paths there are.
 */
export function createRoomScope(options: RoomScopeOptions): RoomScope {
  const scope: RoomScope = {
    roomId: options.roomId,
    releaseId: options.releaseId,
    db: options.db,
    generate: options.generate,
    input: options.input ?? new InputBudget(),
    registry: options.registry,
    matchAdmission: options.matchAdmission,
    inputPolicyMode: options.inputPolicyMode,
    inFlightGeneration: null,
    now: () => Date.now(),
    transact<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
      if (options.transact) return options.transact(fn);
      return fn(options.db as Transaction);
    },
    async push(): Promise<void> {
      if (options.push) await options.push(scope);
      else await pushSnapshots(scope);
    },
    async arm(): Promise<void> {
      if (options.arm) await options.arm(scope);
    },
  };
  return scope;
}
