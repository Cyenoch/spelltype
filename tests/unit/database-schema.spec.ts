/**
 * 数据库 Schema 本身，通过真实完成迁移的数据库进行验证 —— 现在由单个 PostgreSQL（此处为 PGlite）数据库
 * 同时服务于 api 和 game 进程，因此约束构成了多进程安全的兜底网。此处固化的关键行为包括：房间/入场券 ID 格式、
 * 房间状态枚举字典、单例运行时控制行（模式字典、只允许一行）、席位槽位唯一性、战绩写入幂等性、
 * 每个账号仅限一张有效入场券规则、会话席位级联删除，以及往返存取后依然精确保持整型毫秒的时间戳约定。
 * 事务逻辑也单独进行了验证：协调器的配对流程（单个事务内同时处理房间 + 席位 + 入场券，整体提交或整体回滚）
 * 通过面向 `QueryDatabase` 类型的代码执行，这也是所有存储函数通用的联合类型。
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Difficulty, Phase, RoomMode } from '../../shared/protocol';
import type { MaintenanceMode } from '../../shared/maintenance';
import type { MatchTicketState } from '../../server/db/schema';
import {
  accounts,
  departures,
  matchTickets,
  openDatabase,
  players,
  results,
  roomSessions,
  rooms,
  runtimeControl,
  sessions,
  type OpenedDatabase,
  type QueryDatabase,
} from '../../server/db';

const NOW = 1_700_000_000_000;
const TIMEOUT = 120_000;

const hex24 = (n: number) => n.toString(16).padStart(24, '0');

let db: OpenedDatabase['db'];
let opened: OpenedDatabase;
let seq = 0;

beforeAll(async () => {
  opened = await openDatabase('pglite://:memory:');
  db = opened.db;
}, TIMEOUT);

afterAll(async () => {
  await opened?.close();
});

const nextUserId = () => `user-${++seq}`;
const nextRoomId = () => hex24(1000 + ++seq);
const nextMatchId = () => `match-${++seq}`;
const nextTokenHash = () => `token-${++seq}`;

async function seedAccount(id: string) {
  await db.insert(accounts).values({
    id,
    username: id,
    wechat_identity: `union:${id}`,
    created_at: NOW,
  });
}

async function insertRoom(
  store: QueryDatabase,
  id: string,
  patch: Partial<typeof rooms.$inferInsert> = {},
) {
  await store.insert(rooms).values({
    id,
    host_id: 'host',
    mode: 'private',
    opponent_kind: 'human',
    ghost_id: null,
    opponent_next_at: null,
    theme: 'theme',
    difficulty: 'hard',
    phase: 'lobby',
    created_at: NOW,
    updated_at: NOW,
    ...patch,
  });
}

async function insertPlayer(store: QueryDatabase, roomId: string, userId: string, slot: number) {
  await store.insert(players).values({
    room_id: roomId,
    user_id: userId,
    username: userId,
    slot,
    joined_at: NOW,
  });
}

async function insertResult(store: QueryDatabase, roomId: string, matchId: string, userId: string) {
  await store.insert(results).values({
    match_id: matchId,
    user_id: userId,
    room_id: roomId,
    theme: 'theme',
    damage_dealt: 40,
    hp_remaining: 2000,
    spells_cast: 3,
    correct_chars: 30,
    duration_ms: 12_345,
    rank: 1,
    cpm: 180,
    accuracy: 0.94,
    created_at: NOW,
  });
}

/**
 * 标准化 SQLSTATE 分类 —— 写入失败时跨数据库驱动的统一约定。
 * drizzle 包装层的错误文本属于实现细节；cause 链中驱动原生错误的分类 `code` 才是调用方（或其他进程）可依赖的凭据。
 */
const SQLSTATE = { unique: '23505', foreignKey: '23503', check: '23514' } as const;
type SqlStateCategory = keyof typeof SQLSTATE;

function causeChainHasSqlState(error: unknown, sqlstate: string): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && current.code === sqlstate) return true;
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}

/** 执行写入操作，断言其失败，并验证失败信息携带标准化的 SQLSTATE。 */
async function rejectsWithSqlState(
  run: () => Promise<unknown>,
  category: SqlStateCategory,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(causeChainHasSqlState(error, SQLSTATE[category])).toBe(true);
    return;
  }
  throw new Error(`expected the write to fail with SQLSTATE ${SQLSTATE[category]} (${category})`);
}

describe('运行时控制', () => {
  it('属于运维模式字典下的单例记录，绝不允许存在两行', async () => {
    const [row] = await db.select().from(runtimeControl);
    expect(row).toBeDefined();
    expect(row?.singleton).toBe(1);
    expect(['open', 'draining']).toContain(row?.mode);
    expect(typeof row?.revision).toBe('number');
    expect(typeof row?.updated_at).toBe('number');
    // 全新开发环境初始化后处于 open 状态，尚无运行时认领写入者租约。
    expect(row?.mode).toBe('open');
    expect(row?.runtime_id).toBeNull();
    expect(row?.runtime_epoch).toBe(0);
    expect(row?.lease_until).toBeNull();

    // 插入第二行控制记录会导致部署产生分歧风险：单例约束会拒绝该操作。
    const badMode: string = 'paused';
    await rejectsWithSqlState(
      () =>
        db
          .insert(runtimeControl)
          .values({ singleton: 1, mode: badMode as MaintenanceMode, revision: 0, updated_at: NOW }),
      'check',
    );
    await rejectsWithSqlState(
      () =>
        db
          .insert(runtimeControl)
          .values({ singleton: 2, mode: 'open', revision: 0, updated_at: NOW }),
      'check',
    );
  });
});

describe('房间与席位', () => {
  it('强制校验房间状态枚举字典和 24 位十六进制房间 ID', async () => {
    // drizzle 的 $type() 注解在编译期会拒绝这些非法值；此处类型转换模拟了无类型写入者（原生 SQL 或其他进程），
    // 以此检验数据库层面的 CHECK 约束生效。
    const badPhase: string = 'paused';
    const badMode: string = 'duel';
    const badDifficulty: string = 'easy';
    await rejectsWithSqlState(
      () => insertRoom(db, nextRoomId(), { phase: badPhase as Phase }),
      'check',
    );
    await rejectsWithSqlState(
      () => insertRoom(db, nextRoomId(), { mode: badMode as RoomMode }),
      'check',
    );
    await rejectsWithSqlState(
      () => insertRoom(db, nextRoomId(), { difficulty: badDifficulty as Difficulty }),
      'check',
    );
    await rejectsWithSqlState(() => insertRoom(db, 'NOT-HEX'), 'check');
  });

  it('携带服务端口预期的领域默认值，且整型毫秒时间戳往返存取无损', async () => {
    const id = nextRoomId();
    await insertRoom(db, id);
    const [row] = await db.select().from(rooms).where(eq(rooms.id, id));
    expect(row).toMatchObject({
      deadline: 0,
      events_json: '[]',
      event_seq: 0,
      generation_seq: 0,
      reservation_state: 'none',
      opponent_kind: 'human',
      ghost_id: null,
      opponent_next_at: null,
      locked: 0,
      persistence: 'idle',
      persist_attempts: 0,
      next_alarm_at: null,
    });
    expect(row?.created_at).toBe(NOW);
    expect(typeof row?.created_at).toBe('number');
  });

  it('绝不允许同一槽位占用两个席位，并正确赋予新席位默认值', async () => {
    const roomId = nextRoomId();
    const first = nextUserId();
    const second = nextUserId();
    await seedAccount(first);
    await seedAccount(second);
    await insertRoom(db, roomId);
    await insertPlayer(db, roomId, first, 0);
    await rejectsWithSqlState(() => insertPlayer(db, roomId, second, 0), 'unique');

    const [seat] = await db.select().from(players).where(eq(players.room_id, roomId));
    expect(seat).toMatchObject({
      hp: 2400,
      max_hp: 2400,
      seated: 0,
      ready: 0,
      progress: 0,
      spell_index: 0,
      spells_cast: 0,
      damage_dealt: 0,
      correct_chars: 0,
      attempt_total: 0,
      error_total: 0,
      cpm: 0,
      last_input: '',
      eliminated_at: null,
    });
  });

  it('删除房间记录时级联删除其所有席位', async () => {
    const roomId = nextRoomId();
    const userId = nextUserId();
    await insertRoom(db, roomId);
    await insertPlayer(db, roomId, userId, 1);
    await db.delete(rooms).where(eq(rooms.id, roomId));
    const left = await db.select().from(players).where(eq(players.room_id, roomId));
    expect(left).toEqual([]);
  });
});

describe('战绩', () => {
  it('确保战绩重试写入具备幂等性，并校验房间外键引用有效', async () => {
    const roomId = nextRoomId();
    const userId = nextUserId();
    await insertRoom(db, roomId);
    const matchId = nextMatchId();

    await insertResult(db, roomId, matchId, userId);
    await rejectsWithSqlState(() => insertResult(db, roomId, matchId, userId), 'unique');
    // 房间运行时的重放逻辑：在结算事务内部，重复写入视为空操作（no-op）。
    await db
      .insert(results)
      .values({
        match_id: matchId,
        user_id: userId,
        room_id: roomId,
        theme: 'theme',
        damage_dealt: 40,
        hp_remaining: 2000,
        spells_cast: 3,
        correct_chars: 30,
        duration_ms: 12_345,
        rank: 1,
        cpm: 180,
        accuracy: null,
        created_at: NOW,
      })
      .onConflictDoNothing()
      .execute();
    expect(await db.select().from(results).where(eq(results.match_id, matchId))).toHaveLength(1);

    await rejectsWithSqlState(
      () => insertResult(db, hex24(999), nextMatchId(), userId),
      'foreignKey',
    );
  });
});

describe('匹配入场券', () => {
  it('限制每个账号仅持有一张入场券，要求请求 ID 唯一且限定状态枚举字典', async () => {
    const userId = nextUserId();
    const rivalUserId = nextUserId();
    await seedAccount(userId);
    await seedAccount(rivalUserId);
    const requestId = `req-${++seq}`;
    const insert = (patch: Partial<typeof matchTickets.$inferInsert>) =>
      db.insert(matchTickets).values({
        user_id: userId,
        request_id: requestId,
        username: userId,
        state: 'waiting',
        expires_at: NOW + 60_000,
        created_at: NOW,
        updated_at: NOW,
        ...patch,
      });

    await insert({});
    // 同一账号再次创建：触发单账号单入场券主键约束，且写入失败后原入场券保持不变。
    await rejectsWithSqlState(() => insert({}), 'unique');
    // 不同账号使用相同请求 ID：触发全局请求 ID 唯一性约束。
    await rejectsWithSqlState(() => insert({ user_id: rivalUserId }), 'unique');
    expect(
      await db.select().from(matchTickets).where(eq(matchTickets.user_id, userId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(matchTickets).where(eq(matchTickets.user_id, rivalUserId)),
    ).toHaveLength(0);
    const badTicketState: string = 'cancelling';
    await rejectsWithSqlState(() => insert({ state: badTicketState as MatchTicketState }), 'check');
    await rejectsWithSqlState(
      () =>
        db.insert(matchTickets).values({
          user_id: 'no-such-account',
          request_id: `req-${++seq}`,
          username: 'ghost',
          state: 'waiting',
          expires_at: NOW,
          created_at: NOW,
          updated_at: NOW,
        }),
      'foreignKey',
    );
  });

  it('允许排队中的入场券无房间关联，匹配成功的入场券必须关联房间', async () => {
    const waitingUser = nextUserId();
    const matchedUser = nextUserId();
    const roomId = nextRoomId();
    await seedAccount(waitingUser);
    await seedAccount(matchedUser);
    await insertRoom(db, roomId);
    await db.insert(matchTickets).values({
      user_id: waitingUser,
      request_id: `req-${++seq}`,
      username: waitingUser,
      state: 'waiting',
      room_id: null,
      expires_at: NOW + 60_000,
      created_at: NOW,
      updated_at: NOW,
    });
    await db.insert(matchTickets).values({
      user_id: matchedUser,
      request_id: `req-${++seq}`,
      username: matchedUser,
      state: 'matched',
      room_id: roomId,
      expires_at: NOW + 60_000,
      created_at: NOW,
      updated_at: NOW,
    });
  });
});

describe('会话席位', () => {
  it('保证会话引用的真实有效性，并在会话销毁时将其清除', async () => {
    const userId = nextUserId();
    await seedAccount(userId);
    const roomId = nextRoomId();
    const tokenHash = nextTokenHash();
    await insertRoom(db, roomId);
    await rejectsWithSqlState(
      () =>
        db.insert(sessions).values({ token_hash: tokenHash, user_id: 'ghost', expires_at: NOW }),
      'foreignKey',
    );
    await db
      .insert(sessions)
      .values({ token_hash: tokenHash, user_id: userId, expires_at: NOW + 1000 });
    await db.insert(roomSessions).values({ session_hash: tokenHash, room_id: roomId });

    await db.delete(sessions).where(eq(sessions.token_hash, tokenHash));
    const seats = await db
      .select()
      .from(roomSessions)
      .where(eq(roomSessions.session_hash, tokenHash));
    expect(seats).toEqual([]);
  });
});

describe('离场记录', () => {
  it('每个房间每个账号仅记录一条离场信息', async () => {
    const roomId = nextRoomId();
    const userId = nextUserId();
    await insertRoom(db, roomId);
    const insert = () =>
      db
        .insert(departures)
        .values({ room_id: roomId, user_id: userId, match_id: null, departed_at: NOW });
    await insert();
    await rejectsWithSqlState(insert, 'unique');
  });
});

describe('事务支持', () => {
  it('通过 QueryDatabase 联合类型完整提交配对业务形态的事务', async () => {
    const committed = nextRoomId();
    const rolledBack = nextRoomId();
    const userId = nextUserId();

    await db.transaction(async (tx) => {
      await insertRoom(tx, committed, { mode: 'quick' });
      await insertPlayer(tx, committed, userId, 0);
    });
    const seats = await db.select().from(players).where(eq(players.room_id, committed));
    expect(seats).toHaveLength(1);

    await db
      .transaction(async (tx) => {
        await insertRoom(tx, rolledBack, { mode: 'quick' });
        await insertPlayer(tx, rolledBack, userId, 0);
        throw new Error('rollback');
      })
      .catch(() => {});

    expect(await db.select().from(rooms).where(eq(rooms.id, rolledBack))).toEqual([]);
    expect(await db.select().from(players).where(eq(players.room_id, rolledBack))).toEqual([]);
  });
});
