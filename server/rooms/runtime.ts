import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { rooms } from '../db/schema';
import type { Database, Transaction } from '../db';
import { acquireRuntime, type RuntimeOwnership } from '../maintenance/ownership';
import type { InputPolicyMode } from '../../shared/protocol';
import type {
  AuthenticatedSession,
  GenerateSpells,
  RoomRuntimePort,
  RoomSocket,
  RoomSocketData,
} from '../contracts';
import type { RoomSnapshot, ReservationState, User } from '../../shared/protocol';
import { reservationIsGone } from './rules';
import { reservationStateOf } from './reservation';
import { RoomRejection } from './rejection';
import { snapshotFor } from './snapshots';
import { abandonedMatch } from './storage/departures';
import { sessionIsLive } from './storage/room-sessions';
import { RoomEngine } from './engine';

export interface RoomRuntimeOptions {
  database: Database;
  generate: GenerateSpells;
  /** The input-time mode every match this runtime opens locks into its room row. */
  inputPolicyMode: InputPolicyMode;
}

/** How often the runtime re-checks its materialized rooms for external database changes. */
const WATCH_SWEEP_MS = 5_000;

/**
 * The native room runtime: the one process that owns every room. It holds the
 * global runtime lease (the maintenance layer's ownership module), keeps a
 * per-room engine with a serialized command queue for every room it has
 * touched, persists the earliest durable deadline per room in `next_alarm_at`,
 * and recovers due work at startup.
 */
export class RoomRuntime implements RoomRuntimePort {
  readonly runtimeEpoch: number;

  private readonly engines = new Map<string, RoomEngine>();
  private watch: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  private constructor(
    readonly database: Database,
    readonly generate: GenerateSpells,
    readonly inputPolicyMode: InputPolicyMode,
    private readonly ownership: RuntimeOwnership,
  ) {
    this.runtimeEpoch = ownership.epoch;
  }

  /**
   * Acquires the global runtime lease and recovers every room that still owes
   * work. A busy lease — another live owner — fails the startup: two owners
   * would race the rooms. An active room that carries no locked input policy
   * fails the startup too: the runtime refuses to adopt a match it could
   * neither judge nor settle.
   */
  static async start(options: RoomRuntimeOptions): Promise<RoomRuntime> {
    const ownership = await acquireRuntime(options.database, {
      onLost: () => {
        void runtime.handleOwnershipLost();
      },
    });
    const runtime = new RoomRuntime(
      options.database,
      options.generate,
      options.inputPolicyMode,
      ownership,
    );
    try {
      await runtime.rejectUnmeasuredActiveRooms();
      await runtime.recover();
      runtime.watch = setInterval(() => runtime.sweep(), WATCH_SWEEP_MS);
      runtime.watch.unref();
    } catch (error) {
      await ownership.close();
      throw error;
    }
    return runtime;
  }

  // ------------------------------------------------------------------ port API

  /**
   * Validates that the room exists before adopting it. Coordination and HTTP
   * may hand this runtime a stale or unknown room id (a cancel outcome, an
   * old locator); a missing room is a refusal, never an adoption. There is
   * exactly one runtime, so an existing room is always this runtime's own.
   */
  private async engineForOwnRoom(roomId: string): Promise<RoomEngine> {
    const rows = await this.database
      .select({ id: rooms.id })
      .from(rooms)
      .where(eq(rooms.id, roomId))
      .limit(1);
    if (rows[0] === undefined) throw new RoomRejection('room:not_found', '房间不存在或已结束。');
    return this.engineFor(roomId);
  }

  async snapshot(roomId: string, user: User): Promise<RoomSnapshot> {
    const engine = await this.engineForOwnRoom(roomId);
    return snapshotFor(this.database, roomId, engine.registry, user);
  }

  /**
   * Read validation before the HTTP upgrade: the room exists, its reservation
   * has not lapsed, the account has not abandoned its match and the session is
   * still live. The authoritative session check runs again inside the join
   * transaction, where registration races the logout exactly once.
   */
  async authorizeSocket(roomId: string, session: AuthenticatedSession): Promise<void> {
    const rows = await this.database.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    const room = rows[0];
    if (room === undefined) throw new RoomRejection('room:not_found', '房间不存在或已结束。');
    if (reservationIsGone(room, Date.now()))
      throw new RoomRejection('room:reservation_gone', '匹配已结束，请重新匹配。');
    if (await abandonedMatch(this.database, roomId, session.user.id, room.match_id))
      throw new RoomRejection('room:reservation_gone', '你已离开本场对局。');
    if (!(await sessionIsLive(this.database, session.tokenHash)))
      throw new RoomRejection('room:unauthenticated', '登录状态无效，请重新登录。');
  }

  connect(socket: RoomSocket): void {
    const data: RoomSocketData = socket.data;
    this.engineFor(data.roomId).connect(data, socket);
  }

  message(socket: RoomSocket, message: string | Uint8Array): void {
    this.engineFor(socket.data.roomId).message(socket, message);
  }

  disconnect(socket: RoomSocket): void {
    this.engineFor(socket.data.roomId).disconnect(socket);
  }

  async leaveRoom(roomId: string, userId: string): Promise<void> {
    const engine = await this.engineForOwnRoom(roomId);
    await engine.leaveRoom(userId);
  }

  async revokeSession(tokenHash: string): Promise<void> {
    const targets = [...this.engines.values()].filter((engine) =>
      engine.registry
        .list()
        .some((socket) => engine.registry.metaOf(socket)?.sessionHash === tokenHash),
    );
    const acknowledged = await Promise.all(
      targets.map((engine) => engine.revokeSession(tokenHash)),
    );
    if (acknowledged.some((ok) => !ok)) throw new Error('room:revoke_incomplete');
  }

  /** Adopts and reconciles one room: adopts DB-only rooms and surfaces external changes. */
  async refreshRoom(roomId: string): Promise<void> {
    const engine = await this.engineForOwnRoom(roomId);
    await engine.refresh();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.watch !== null) {
      clearInterval(this.watch);
      this.watch = null;
    }
    await Promise.all([...this.engines.values()].map((engine) => engine.stop()));
    await this.ownership.close();
  }

  // ----------------------------------------------------------------- internals

  /** The write fence every room mutation transaction asserts before its first statement. */
  assertOwnership(tx: Transaction): Promise<void> {
    return this.ownership.assert(tx);
  }

  /** Reservation state for coordination reads; an uninitialized room reads `none`. */
  async reservationState(roomId: string): Promise<ReservationState> {
    const rows = await this.database.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
    return reservationStateOf(rows[0] ?? null, Date.now());
  }

  /**
   * Gets or materializes the engine for one room. Construction is synchronous,
   * so get-or-create is atomic; timers arm only inside queued commands.
   */
  private engineFor(roomId: string): RoomEngine {
    let engine = this.engines.get(roomId);
    if (engine === undefined) {
      engine = new RoomEngine(this, roomId);
      this.engines.set(roomId, engine);
    }
    return engine;
  }

  /**
   * Startup recovery: every room that owes a wake-up — a due timer, a live
   * match, an open reservation, an open lobby — gets its engine and an
   * immediate catch-up pass. A generation interrupted by a crash is failed
   * honestly by the catch-up, exactly like the old alarm catch-up.
   */
  private async recover(): Promise<void> {
    const now = Date.now();
    const due = await this.database
      .select({ id: rooms.id })
      .from(rooms)
      .where(
        or(
          and(isNotNull(rooms.next_alarm_at), sql`${rooms.next_alarm_at} <= ${now}`),
          inArray(rooms.phase, ['generating', 'countdown', 'playing']),
          eq(rooms.reservation_state, 'reserved'),
          and(eq(rooms.locked, 0), eq(rooms.phase, 'lobby')),
        ),
      );
    await Promise.all(due.map((row) => this.engineFor(row.id).catchup()));
  }

  /**
   * Refuses to adopt a generating, countdown or playing room whose match
   * policy was never locked: judging, snapshots and settlement all read those
   * columns, and measuring a match mid-flight would invent a start time for
   * spells already typed. The check is one startup query over every active
   * room — the single runtime owns them all, so an unmeasured active match is
   * always this runtime's business and always fails the startup.
   */
  private async rejectUnmeasuredActiveRooms(): Promise<void> {
    const unmeasured = await this.database
      .select({ id: rooms.id, phase: rooms.phase })
      .from(rooms)
      .where(
        and(
          inArray(rooms.phase, ['generating', 'countdown', 'playing']),
          or(
            isNull(rooms.input_policy_version),
            isNull(rooms.input_policy_mode),
            isNull(rooms.input_min_ms_per_code_point),
          ),
        ),
      );
    const first = unmeasured[0];
    if (first === undefined) return;
    console.error({ roomId: first.id, phase: first.phase, reason: 'input_policy_drain_required' });
    throw new Error('input_policy_drain_required');
  }

  /** Periodic watch: re-read committed state so external database changes surface promptly. */
  private sweep(): void {
    if (this.stopped) return;
    for (const engine of this.engines.values()) void engine.refresh();
  }

  /** The lease was taken over or expired: stop everything and release the sockets. */
  private async handleOwnershipLost(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    console.error('[room] runtime ownership lost; stopping');
    if (this.watch !== null) {
      clearInterval(this.watch);
      this.watch = null;
    }
    await Promise.all([...this.engines.values()].map((engine) => engine.stop()));
  }
}

/**
 * Creates the room runtime: acquires the global runtime lease, recovers due
 * rooms and returns the port Main's composition mounts. The generation
 * function is the injected pipeline Main composes — the fixture uses a real
 * one against a fixture model.
 */
export async function createRoomRuntime(options: RoomRuntimeOptions): Promise<RoomRuntimePort> {
  return RoomRuntime.start(options);
}
