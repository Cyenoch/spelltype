/**
 * 输入门槛 — 服务端施法时间门槛的验收回归。
 *
 * 每个用例驱动房间的公共入口（`handleClientFrame` → `handleInput`、`advanceOnce`、
 * `manualLeave`、`startMatchTx`、`snapshotFor`）打到真实 PGlite 上，时钟只经
 * Bun 原生 `setSystemTime` 一致控制。可观察契约：enforce 拒绝只推进代际并记录原因/采样，绝不入
 * 批次；acceptance 与资格、采样、游标在同一提交里，伤害与事件等窗口末的
 * advanceCombat 才落地；恢复计数只认当前咒文；资源窗口第 61 个合法 input 恰好一次
 * 废除所有权并 4004；策略在开局锁定、重开不重算、新局清零；损坏状态被同一句话拒绝
 * 且快照给 null gate；开局/倒计时转换/接受/结算四条路径的中途 SQL 异常各自整体回滚。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, setSystemTime, spyOn } from 'bun:test';
import type { Mock } from 'bun:test';
import { eq, getTableName } from 'drizzle-orm';
import {
  COMBAT_BATCH_MS,
  INITIAL_HEALTH,
  MATCH_DURATION_MS,
  WS_CLOSE,
  WS_PROTOCOL,
  type InputPolicyMode,
  type RoomSnapshot,
  type ServerMessage,
  type Spell,
} from '../../shared/protocol';
import type { RoomSocket } from '../../server/contracts';
import type { Database, OpenedDatabase, Transaction } from '../../server/db';
import { openDatabase, runtimeControl } from '../../server/db';
import { players as playersTable, results } from '../../server/db/schema';
import { handleClientFrame } from '../../server/rooms/frames';
import { INPUT_GATE_ERROR_MESSAGE } from '../../server/rooms/input-gate';
import { manualLeave } from '../../server/rooms/leave';
import { startMatchTx } from '../../server/rooms/match';
import { INPUT_MIN_MS_PER_CODE_POINT, INPUT_POLICY_VERSION } from '../../server/rooms/rules';
import { createRoomScope, InputBudget, SocketRegistry } from '../../server/rooms/scope';
import type { RoomScope, SocketAuth } from '../../server/rooms/scope';
import { pushSnapshots, snapshotFor } from '../../server/rooms/snapshots';
import { abandonedMatch } from '../../server/rooms/storage/departures';
import { readEvents } from '../../server/rooms/storage/events';
import type { PlayerRow, RoomRow } from '../../server/db/schema';
import { getPlayer, insertPlayer, updatePlayer } from '../../server/rooms/storage/players';
import { createRoom, getRoom, updateRoom } from '../../server/rooms/storage/room';
import { readSpellBook } from '../../server/rooms/storage/spell-book';
import { readVolley } from '../../server/rooms/storage/volley';
import { advanceOnce } from '../../server/rooms/transitions';
import { charCount, damageOf, spellAt } from '../../server/scoring';
import type { InputFrame } from '../../server/rooms/combat';
import { RuntimeOwnershipLostError, acquireRuntime } from '../../server/maintenance/ownership';

// Freeze relative offsets without moving PGlite's process-wide timers back by years.
const T0 = Date.now();
const ROOM_ID = 'b'.repeat(24);
const MATCH_ID = 'match-gate';
const COMBAT_END = T0 + MATCH_DURATION_MS;
/** 座位不可能产出的锁定模式：锁定列只允许 observe/enforce，其余按损坏拒绝。 */
const INVALID_POLICY_MODE = 'normal' as InputPolicyMode;
/**
 * 四条咒文：长度各不相同，让「新资格按各自法术的码点成本计算」可被精确断言；
 * 第二条含代理对，把「长度按码点、不按 UTF-16 单元」钉进端到端裁决。
 */
const BOOK: Spell[] = [
  { name: 'Ember', text: 'AB', translation: '余烬', element: 'fire' },
  { name: 'Rune', text: 'A𐍈B', translation: '符文', element: 'arcane' },
  { name: 'Frost', text: 'ABCD', translation: '寒霜', element: 'ice' },
  { name: 'Storm', text: 'ABCDEF', translation: '风暴', element: 'storm' },
];
/** 每条咒文的门槛时长：码点数 × 每码点成本（非显而易见的公式，测试反复引用）。 */
const floorOf = (text: string): number => charCount(text) * INPUT_MIN_MS_PER_CODE_POINT;

interface StubSocket {
  socket: RoomSocket;
  /** 模拟一个关闭尚未落地、仍在投递排队帧的传输层。 */
  reopen(): void;
  sent: ServerMessage[];
  closes: { code: number; reason: string }[];
}

let now = T0;
let consoleErrors: Mock<typeof console.error> | null = null;
const databases: OpenedDatabase[] = [];

function metaOf(userId: string, connId = `${userId}-conn`): SocketAuth {
  return {
    userId,
    username: userId,
    connId,
    sessionHash: `${userId}-session`,
    sessionExpires: T0 + 3_600_000,
    protocolVersion: WS_PROTOCOL,
  };
}

function stubSocket(_userId: string): StubSocket {
  const state: StubSocket = {
    socket: null as unknown as RoomSocket,
    reopen() {
      readyState = 1;
    },
    sent: [],
    closes: [],
  };
  let readyState = 1;
  state.socket = {
    get readyState() {
      return readyState;
    },
    data: { roomId: ROOM_ID, protocolVersion: WS_PROTOCOL, session: null },
    send: (raw: string) => {
      state.sent.push(JSON.parse(raw) as ServerMessage);
    },
    close: (code: number, reason: string) => {
      state.closes.push({ code, reason });
      readyState = 3;
    },
  } as unknown as RoomSocket;
  return state;
}

/**
 * 事务级故障注入：截住对指定表的第一个写操作并抛错，由真实数据库事务整体回滚。
 * `table` 是 Drizzle 表名（rooms / players / results）。
 */
interface SqlInjection {
  op: 'update' | 'insert';
  table: string;
}

let injection: SqlInjection | null = null;

function interceptTx(tx: Transaction): Transaction {
  if (injection === null) return tx;
  const rule = injection;
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === rule.op) {
        return (table: Parameters<typeof getTableName>[0]) => {
          if (getTableName(table) === rule.table) throw new Error('injected sql failure');
          const inner = Reflect.get(target, prop) as (
            t: Parameters<typeof getTableName>[0],
          ) => unknown;
          return inner.call(target, table);
        };
      }
      return Reflect.get(target, prop);
    },
  });
}

/** 让下一次 scope.transact 在运行事务体之前把时钟推进 `advanceMs`（恢复时刻的接缝）。 */
let transactDelay: number | null = null;
/** 让下一次 scope.push 等到放行再投递（结算后投递前的替换竞态接缝）。 */
let pushGate: {
  entered: PromiseWithResolvers<void>;
  release: PromiseWithResolvers<void>;
} | null = null;

interface Harness {
  db: Database;
  scope: RoomScope;
  registry: SocketRegistry;
  sockets: Record<string, StubSocket>;
  /** 挂一个新连接并把座位指给它（第二连接接管）。 */
  takeover(userId: string, connId: string): Promise<StubSocket>;
  /** 按座位当前持久状态构造合法 input 帧；`overrides` 显式制造旧值。 */
  frame(
    userId: string,
    text?: string,
    overrides?: { matchId?: string; spellIndex?: number; draftEpoch?: number },
  ): Promise<InputFrame>;
  /** 以座位的当前连接发送（正常路径）。 */
  send(userId: string, frame: InputFrame): Promise<void>;
  /** 以指定连接发送（接管后的新连接）。 */
  sendAs(userId: string, connId: string, frame: InputFrame): Promise<void>;
  /** 把时钟移到 T0 + offsetMs。 */
  at(offsetMs: number): void;
  snapshot(userId: string): Promise<RoomSnapshot>;
  player(userId: string): Promise<PlayerRow>;
  room(): Promise<RoomRow | null>;
}

async function buildHarness(
  db: Database,
  userIds: readonly string[],
  mode: InputPolicyMode,
): Promise<Harness> {
  const sockets: Record<string, StubSocket> = {};
  const registry = new SocketRegistry();
  for (const userId of userIds) {
    sockets[userId] = stubSocket(userId);
    registry.attach(sockets[userId].socket, metaOf(userId));
  }
  const scope = createRoomScope({
    roomId: ROOM_ID,
    db,
    generate: async () => {
      throw new Error('generation not expected in gate tests');
    },
    registry,
    inputPolicyMode: mode,
    input: new InputBudget(),
    transact: (fn) =>
      db.transaction(async (tx) => {
        if (transactDelay !== null) {
          const delay = transactDelay;
          transactDelay = null;
          now += delay;
          setSystemTime(now);
        }
        return fn(interceptTx(tx));
      }),
    push: async (s) => {
      if (pushGate !== null) {
        const gate = pushGate;
        pushGate = null;
        gate.entered.resolve();
        await gate.release.promise;
      }
      await pushSnapshots(s);
    },
    arm: async () => {},
  });
  const socketFor = (userId: string, connId: string): RoomSocket => {
    const key = connId === `${userId}-conn` ? userId : `${userId}:${connId}`;
    return sockets[key].socket;
  };
  return {
    db,
    scope,
    registry,
    sockets,
    async takeover(userId, connId) {
      const stub = stubSocket(userId);
      sockets[`${userId}:${connId}`] = stub;
      registry.attach(stub.socket, metaOf(userId, connId));
      await updatePlayer(db, ROOM_ID, userId, { conn_id: connId });
      return stub;
    },
    async frame(userId, text, overrides) {
      const room = (await getRoom(db, ROOM_ID))!;
      const self = (await getPlayer(db, ROOM_ID, userId))!;
      const spell = spellAt(readSpellBook(room), self.spell_index)!;
      return {
        type: 'input',
        matchId: room.match_id!,
        spellIndex: self.spell_index,
        draftEpoch: self.draft_epoch,
        text: text ?? spell.text,
        ...overrides,
      };
    },
    async send(userId, frame) {
      await handleClientFrame(scope, socketFor(userId, `${userId}-conn`), metaOf(userId), frame);
    },
    async sendAs(userId, connId, frame) {
      await handleClientFrame(scope, socketFor(userId, connId), metaOf(userId, connId), frame);
    },
    at(offsetMs) {
      now = T0 + offsetMs;
      setSystemTime(now);
    },
    async snapshot(userId) {
      return snapshotFor(db, ROOM_ID, registry, { id: userId, username: userId });
    },
    async player(userId) {
      return (await getPlayer(db, ROOM_ID, userId))!;
    },
    room() {
      return getRoom(db, ROOM_ID);
    },
  };
}

async function openTestDb(): Promise<Database> {
  const opened = await openDatabase('pglite://:memory:');
  databases.push(opened);
  return opened.db;
}

async function seedMatchRoom(
  db: Database,
  userIds: readonly string[],
  options: {
    mode: InputPolicyMode;
    phase: 'countdown' | 'playing';
    openedAt: number | null;
    deadline: number;
  },
): Promise<void> {
  await createRoom(db, {
    id: ROOM_ID,
    host: { id: userIds[0], username: userIds[0] },
    theme: '门槛契约',
    mode: 'private',
  });
  await updateRoom(db, ROOM_ID, {
    phase: options.phase,
    locked: 1,
    match_id: MATCH_ID,
    started_at: options.phase === 'playing' ? T0 : null,
    deadline: options.deadline,
    spell_book: JSON.stringify(BOOK),
    input_policy_version: INPUT_POLICY_VERSION,
    input_policy_mode: options.mode,
    input_min_ms_per_code_point: INPUT_MIN_MS_PER_CODE_POINT,
  });
  for (const [slot, userId] of userIds.entries()) {
    await insertPlayer(db, ROOM_ID, { userId, username: userId, slotExpiresAt: null, now: T0 });
    await updatePlayer(db, ROOM_ID, userId, { seated: 1, conn_id: `${userId}-conn` });
    if (options.openedAt !== null) {
      // 首条咒语（下标 0）的资格；倒计时中的座位没有任何资格可预览。
      await updatePlayer(db, ROOM_ID, userId, {
        input_opened_at: options.openedAt,
        input_not_before: options.openedAt + floorOf(BOOK[0].text),
      });
    }
    void slot;
  }
}

async function playingHarness(
  userIds: readonly string[],
  options: { mode: InputPolicyMode; openedAt?: number },
): Promise<Harness> {
  const db = await openTestDb();
  await seedMatchRoom(db, userIds, {
    mode: options.mode,
    phase: 'playing',
    openedAt: options.openedAt ?? T0,
    deadline: COMBAT_END,
  });
  return buildHarness(db, userIds, options.mode);
}

async function countdownHarness(
  userIds: readonly string[],
  mode: InputPolicyMode,
): Promise<Harness> {
  const db = await openTestDb();
  await seedMatchRoom(db, userIds, {
    mode: 'enforce',
    phase: 'countdown',
    openedAt: null,
    deadline: T0 + 3_000,
  });
  return buildHarness(db, userIds, mode);
}

async function lobbyHarness(
  userIds: readonly string[],
): Promise<{ db: Database; scope: RoomScope }> {
  const db = await openTestDb();
  await createRoom(db, {
    id: ROOM_ID,
    host: { id: userIds[0], username: userIds[0] },
    theme: '门槛契约',
    mode: 'private',
  });
  for (const userId of userIds) {
    await insertPlayer(db, ROOM_ID, { userId, username: userId, slotExpiresAt: null, now: T0 });
    await updatePlayer(db, ROOM_ID, userId, { seated: 1, conn_id: `${userId}-conn`, ready: 1 });
  }
  const scope = createRoomScope({
    roomId: ROOM_ID,
    db,
    generate: async () => {
      throw new Error('generation not expected in gate tests');
    },
    registry: new SocketRegistry(),
    inputPolicyMode: 'enforce',
    input: new InputBudget(),
  });
  return { db, scope };
}

/** 结算批次里在 `atMs` 提交的施法所属窗口的末时刻。 */
function windowEnd(atMs: number): number {
  return T0 + Math.floor(atMs / COMBAT_BATCH_MS) * COMBAT_BATCH_MS + COMBAT_BATCH_MS;
}

/** Opens one fenced transaction for a direct start call, exactly like the production callers. */
function runStart(db: Database, room: RoomRow, mode: InputPolicyMode): Promise<boolean> {
  return db.transaction((tx) => startMatchTx(interceptTx(tx), ROOM_ID, room, mode));
}

beforeEach(() => {
  now = T0;
  injection = null;
  transactDelay = null;
  pushGate = null;
  setSystemTime(now);
  consoleErrors = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  try {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  } finally {
    setSystemTime();
    consoleErrors?.mockRestore();
  }
});

describe('enforce 门槛与恢复', () => {
  it('开局瞬发整段完成被拒：血量/事件/游标/完成数不动，代际 +1 并记录原因与首次采样', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await h.send('a', await h.frame('a'));

    expect(await h.player('a')).toMatchObject({
      spell_index: 0,
      spells_cast: 0,
      hp: INITIAL_HEALTH,
      last_input: '',
      draft_epoch: 1,
      input_reset_reason: 'completion_too_early',
      input_sampled: 1,
      input_gate_hits: 1,
      input_recoveries: 1,
      input_min_completion_ratio: 0,
      input_opened_at: T0,
      input_not_before: T0 + floorOf(BOOK[0].text),
    });
    expect(await h.player('b')).toMatchObject({ hp: INITIAL_HEALTH });
    expect(readEvents((await h.room())!)).toEqual([]);
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();

    const snapshot = await h.snapshot('a');
    expect(snapshot.selfInputGate).toEqual({
      policyVersion: INPUT_POLICY_VERSION,
      mode: 'enforce',
      draftEpoch: 1,
      notBefore: T0 + floorOf(BOOK[0].text),
      resetReason: 'completion_too_early',
    });
    expect(snapshot.selfInputStats).toEqual({ attemptTotal: 0, errorTotal: 0 });
  });

  it('带历史错误的已接受草稿被过早完成：草稿与统计原样保留，恢复本身不计数；就绪后补全恰好命中一次', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(30);
    await h.send('a', await h.frame('a', 'AX')); // 含一个错误字符的草稿被正常接受
    expect(await h.player('a')).toMatchObject({
      last_input: 'AX',
      progress: 1,
      attempt_total: 2,
      error_total: 1,
    });

    h.at(69);
    await h.send('a', await h.frame('a')); // 门槛前完成：被拒，草稿与统计精确回原样
    expect(await h.player('a')).toMatchObject({
      draft_epoch: 1,
      last_input: 'AX',
      progress: 1,
      attempt_total: 2,
      error_total: 1,
      input_recoveries: 1,
      input_recovered_completions: 0,
    });
    const snapshot = await h.snapshot('a');
    expect(snapshot.selfInput).toBe('AX');
    expect(snapshot.selfInputStats).toEqual({ attemptTotal: 2, errorTotal: 1 });

    h.at(70);
    await h.send('a', await h.frame('a')); // 新代际、门槛恰满足：一次命中
    expect(await h.player('a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
      correct_chars: 2,
      attempt_total: 3, // 'AX' 两次 + 替换修正一次（'X'→'B'），错误不清零
      error_total: 1,
      draft_epoch: 0,
      input_reset_reason: null,
      input_recovered_completions: 1,
      input_opened_at: T0 + 70,
      input_not_before: T0 + 70 + floorOf(BOOK[1].text),
    });
    h.at(100);
    await advanceOnce(h.scope);
    expect(await h.player('b')).toMatchObject({
      hp: INITIAL_HEALTH - damageOf(BOOK[0].text),
    });
    expect(readEvents((await h.room())!)).toHaveLength(1);
  });

  it('门槛边界：T+69 拒、新代际在 T+70 恰好命中一次', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(69);
    await h.send('a', await h.frame('a'));
    expect(await h.player('a')).toMatchObject({ draft_epoch: 1, spells_cast: 0 });
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();

    h.at(70);
    await h.send('a', await h.frame('a'));
    const volley = (await readVolley(h.db, ROOM_ID))!;
    expect(volley.casts).toEqual([
      { attackerId: 'a', spellIndex: 0, element: 'fire', power: damageOf(BOOK[0].text) },
    ]);
    expect(volley.endsAt).toBe(windowEnd(70));
  });

  it('等待接受事务跨过窗口末：先兑现致死承诺，迟到对手不能反击成平局', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    const power = damageOf(BOOK[0].text);
    await updatePlayer(h.db, ROOM_ID, 'a', { hp: power });
    await updatePlayer(h.db, ROOM_ID, 'b', { hp: power });
    h.at(70);
    await h.send('a', await h.frame('a'));
    h.at(99);
    transactDelay = 2;
    await h.send('b', await h.frame('b'));
    await advanceOnce(h.scope);

    expect(await h.player('a')).toMatchObject({ hp: power, spells_cast: 1 });
    expect(await h.player('b')).toMatchObject({ hp: 0, spells_cast: 0 });
    expect(await h.room()).toMatchObject({ phase: 'finished', ended_at: windowEnd(70) });
    expect(readEvents((await h.room())!).map((event) => event.attackerId)).toEqual(['a']);
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
    expect(
      await h.db
        .select({ userId: results.user_id, rank: results.rank })
        .from(results)
        .where(eq(results.match_id, MATCH_ID))
        .orderBy(results.user_id),
    ).toEqual([
      { userId: 'a', rank: 1 },
      { userId: 'b', rank: 2 },
    ]);
  });

  it.each(['A', 'AB'])('等待接受事务跨过比赛截止：拒绝草稿或完成 %s 的所有变化', async (text) => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(MATCH_DURATION_MS - 1);
    transactDelay = 2;
    await h.send('a', await h.frame('a', text));
    await advanceOnce(h.scope);

    expect(await h.room()).toMatchObject({
      phase: 'finished',
      end_reason: 'timeout',
      ended_at: COMBAT_END,
    });
    expect(await h.player('a')).toMatchObject({
      spells_cast: 0,
      attempt_total: 0,
      correct_chars: 0,
    });
    expect(await h.player('b')).toMatchObject({ hp: INITIAL_HEALTH });
    expect(readEvents((await h.room())!)).toEqual([]);
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
  });

  it('恢复后只接受草稿不产生施法，跨过门槛也没有自动攻击，真正补全才命中一次', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(69);
    await h.send('a', await h.frame('a'));
    h.at(70);
    await h.send('a', await h.frame('a', 'A')); // 新代际的部分草稿：只更新快照
    expect(await h.player('a')).toMatchObject({
      last_input: 'A',
      progress: 1,
      attempt_total: 1,
      spell_index: 0,
      spells_cast: 0,
    });
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();

    h.at(500); // 时间自己跨过门槛：没有任何自动提交或攻击
    await advanceOnce(h.scope);
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
    expect(readEvents((await h.room())!)).toEqual([]);
    expect(await h.player('a')).toMatchObject({ spells_cast: 0 });

    await h.send('a', await h.frame('a')); // 用户真正补全：一次入队
    expect(await h.player('a')).toMatchObject({ spell_index: 1, spells_cast: 1 });
    h.at(600);
    await advanceOnce(h.scope);
    expect(
      readEvents((await h.room())!).map((event) => [event.attackerId, event.spellIndex]),
    ).toEqual([['a', 0]]);
    expect(await h.player('b')).toMatchObject({
      hp: INITIAL_HEALTH - damageOf(BOOK[0].text),
    });
  });

  it('拒绝后旧代际的重复补全/编辑不再改变任何状态；伪造 observe 模式也无法绕过 enforce', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(69);
    await h.send('a', await h.frame('a'));
    const rejected = await h.player('a');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await h.send('a', await h.frame('a', 'AB', { draftEpoch: 0 }));
      await h.send('a', await h.frame('a', 'AXQ', { draftEpoch: 0 }));
    }
    expect(await h.player('a')).toEqual(rejected);
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
    expect(readEvents((await h.room())!)).toEqual([]);

    // 帧内伪造 observe 模式与零成本：裁决只认房内锁定策略，仍被拒并推进代际。
    const forged = {
      ...(await h.frame('a', 'AB', { draftEpoch: 1 })),
      mode: 'observe',
      input_min_ms_per_code_point: 0,
    } as unknown as InputFrame; // 协议之外的字段由 schema 剥离，这里直接证明裁决不读它们
    h.at(69);
    await h.send('a', forged);
    expect(await h.player('a')).toMatchObject({
      draft_epoch: 2,
      input_recoveries: 2,
      spells_cast: 0,
      input_opened_at: T0,
    });
  });

  it('持久化的 epoch 已达安全整数上限：座位按损坏拒绝（null gate 与明确错误），绝不自增、回绕或伪装就绪', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await updatePlayer(h.db, ROOM_ID, 'a', { draft_epoch: Number.MAX_SAFE_INTEGER });

    // 上限代际是损坏的持久状态：快照不再发布看似健康的 gate，客户端停止提交。
    const snapshot = await h.snapshot('a');
    expect(snapshot.selfInputGate).toBeNull();
    expect(snapshot.selfInputStats).toBeNull();
    expect(snapshot.error).toBe(INPUT_GATE_ERROR_MESSAGE);

    h.at(69);
    await h.send('a', await h.frame('a'));
    expect(await h.player('a')).toMatchObject({
      draft_epoch: Number.MAX_SAFE_INTEGER, // 不自增、不回绕
      input_recoveries: 0,
      input_gate_hits: 0,
      input_reset_reason: null,
    });
    h.at(70); // 即便时刻门槛已满足，损坏的座位也不接受
    await h.send('a', await h.frame('a'));
    expect(await h.player('a')).toMatchObject({
      draft_epoch: Number.MAX_SAFE_INTEGER,
      spell_index: 0,
      spells_cast: 0,
    });
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
    expect(readEvents((await h.room())!)).toEqual([]);
  });
});

describe('observe 观察模式', () => {
  it('同样的过早整段完成照常命中并记录 gate hit、0 恢复；伪造 enforce 字段不改变观察行为', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'observe', openedAt: T0 });
    await h.send('a', await h.frame('a'));
    expect(await h.player('a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
      input_gate_hits: 1,
      input_recoveries: 0,
      draft_epoch: 0,
      input_reset_reason: null,
      input_sampled: 0, // 采样随接受结算：旗标只属于刚完成的那条咒文
      input_min_completion_ratio: 0,
    });

    // 第二条同样瞬发，帧里伪造 enforce 与零成本：房间仍按观察模式放行并继续记录。
    const forged = {
      ...(await h.frame('a')),
      mode: 'enforce',
      input_min_ms_per_code_point: 0,
    } as unknown as InputFrame; // 同上：裁决只读房内锁定策略
    await h.send('a', forged);
    expect(await h.player('a')).toMatchObject({
      spell_index: 2,
      spells_cast: 2,
      input_gate_hits: 2,
      input_recoveries: 0,
    });

    h.at(100);
    await advanceOnce(h.scope);
    const expectedDamage = damageOf(BOOK[0].text) + damageOf(BOOK[1].text);
    expect(await h.player('b')).toMatchObject({ hp: INITIAL_HEALTH - expectedDamage });
    expect((await h.snapshot('a')).selfInputGate?.mode).toBe('observe');
  });
});

describe('资格来源与开局', () => {
  it('资格在进入对局时已发布：首帧到达前快照可见，首帧迟到不重建开启时刻', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(69);
    // 首帧尚未到达，门槛已在开启时刻被计算：差 1ms 就绪。
    expect((await h.snapshot('a')).selfInputGate).toMatchObject({
      notBefore: T0 + floorOf(BOOK[0].text),
    });

    h.at(70);
    await h.send('a', await h.frame('a')); // 若按首帧时刻重建，此刻不可能就绪
    expect(await h.player('a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
      input_opened_at: T0 + 70,
    });
  });

  it('倒计时中的预览输入无效：不写资格、不入队、不推进', async () => {
    const h = await countdownHarness(['a', 'b'], 'enforce');
    h.at(1_000);
    await h.send('a', {
      type: 'input',
      matchId: MATCH_ID,
      spellIndex: 0,
      draftEpoch: 0,
      text: BOOK[0].text,
    });

    expect(await h.room()).toMatchObject({ phase: 'countdown' });
    expect(await h.player('a')).toMatchObject({
      input_opened_at: null,
      input_not_before: null,
      draft_epoch: 0,
      spell_index: 0,
      spells_cast: 0,
      hp: INITIAL_HEALTH,
    });
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
  });

  it('转换期间钟表前进：资格按恢复后的真实时间计算，比赛时钟仍按原截止', async () => {
    const h = await countdownHarness(['a', 'b'], 'enforce');
    h.at(3_000); // 倒计时截止已到，轮到转换运行
    transactDelay = 500; // 事务体开跑前的真实延迟（恢复中的索引写等）
    expect(await advanceOnce(h.scope)).toMatchObject({ progressed: true });

    expect(await h.room()).toMatchObject({
      phase: 'playing',
      started_at: T0 + 3_000, // 开局时刻是原倒计时截止，不因拖延后移
      deadline: T0 + 3_000 + MATCH_DURATION_MS,
    });
    for (const userId of ['a', 'b']) {
      expect(await h.player(userId)).toMatchObject({
        input_opened_at: T0 + 3_500, // 资格按恢复后的时间起算
        input_not_before: T0 + 3_500 + floorOf(BOOK[0].text),
      });
    }
    const snapshot = await h.snapshot('a');
    expect(snapshot.phase).toBe('playing');
    expect(snapshot.selfInputGate).toMatchObject({
      mode: 'enforce',
      draftEpoch: 0,
      notBefore: T0 + 3_500 + floorOf(BOOK[0].text),
    });
  });

  it('已错过整场比赛的倒计时：转入即按原截止超时终局，不产生可操作的对局', async () => {
    const h = await countdownHarness(['a', 'b'], 'enforce');
    h.at(3_000 + MATCH_DURATION_MS + 1_000); // catch-up 迟到：整场比赛时间都已耗尽
    expect(await advanceOnce(h.scope)).toMatchObject({ progressed: true });

    const room = (await h.room())!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('timeout');
    expect(room.started_at).toBe(T0 + 3_000); // 比赛时钟固定在原截止推导，不因晚 alarm 延长
    expect(room.ended_at).toBe(T0 + 3_000 + MATCH_DURATION_MS);
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
    expect(readEvents(room)).toEqual([]);
    // 双方都满血活到终局：生存并列共享第一。
    expect(
      await h.db
        .select({ user_id: results.user_id, rank: results.rank })
        .from(results)
        .orderBy(results.user_id),
    ).toEqual([
      { user_id: 'a', rank: 1 },
      { user_id: 'b', rank: 1 },
    ]);
  });
});

describe('重放、游标与循环', () => {
  it('重复完成、旧下标与旧比赛帧只生效一次', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'observe', openedAt: T0 });
    await h.send('a', await h.frame('a'));
    const accepted = await h.player('a');
    expect(accepted).toMatchObject({ spell_index: 1, spells_cast: 1 });

    await h.send('a', await h.frame('a', 'AB', { spellIndex: 0 })); // 完全相同的旧帧重放
    await h.send('a', await h.frame('a', 'XX', { spellIndex: 0 })); // 旧下标携带不同文本
    await h.send('a', await h.frame('a', 'AB', { matchId: 'match-0' })); // 旧比赛
    expect(await h.player('a')).toEqual(accepted);
    expect((await readVolley(h.db, ROOM_ID))!.casts).toHaveLength(1);

    h.at(100);
    await advanceOnce(h.scope);
    expect(readEvents((await h.room())!)).toHaveLength(1);
    expect(await h.player('b')).toMatchObject({
      hp: INITIAL_HEALTH - damageOf(BOOK[0].text),
    });
  });

  it('同刻完成下一条被拒：新法术的新资格不继承旧时刻', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(70);
    await h.send('a', await h.frame('a'));
    expect(await h.player('a')).toMatchObject({
      spell_index: 1,
      input_opened_at: T0 + 70,
      input_not_before: T0 + 70 + floorOf(BOOK[1].text), // T0+175
    });

    await h.send('a', await h.frame('a')); // 同一刻完成第二条：被拒
    expect(await h.player('a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
      draft_epoch: 1,
      input_reset_reason: 'completion_too_early',
      input_opened_at: T0 + 70, // 资格不被拒绝改写
      input_not_before: T0 + 175,
    });
    expect((await readVolley(h.db, ROOM_ID))!.casts).toHaveLength(1);
  });

  it('跨过整本书循环：下标单调递增，新资格按各法术长度隔离，全程零恢复', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await updatePlayer(h.db, ROOM_ID, 'a', { hp: 1_000_000 });
    await updatePlayer(h.db, ROOM_ID, 'b', { hp: 1_000_000 });

    let acceptAt = floorOf(BOOK[0].text); // 首条恰在门槛时刻完成
    for (let index = 0; index < 26; index += 1) {
      h.at(acceptAt);
      await h.send('a', await h.frame('a'));
      const a = await h.player('a');
      expect(a.spell_index).toBe(index + 1); // 身份单调，从不对 24 取模
      expect(a.input_opened_at).toBe(T0 + acceptAt);
      const next = spellAt(BOOK, index + 1)!;
      expect(a.input_not_before).toBe(T0 + acceptAt + floorOf(next.text));
      expect(a).toMatchObject({ input_gate_hits: 0, input_recoveries: 0, spells_cast: index + 1 });

      // 本轮施法还在窗口里等待：已落地的只有之前各轮的批次。
      const events = readEvents((await h.room())!);
      expect(events.map((event) => event.spellIndex)).toEqual(
        Array.from({ length: index }, (_, i) => i),
      );
      acceptAt += 300; // 每轮都跨过 100ms 窗口与最长门槛（210ms）
    }

    // 最后一窗到点：26 条批次各自按自己的窗口末恰好落地一次。
    h.at(acceptAt);
    await advanceOnce(h.scope);
    const events = readEvents((await h.room())!);
    expect(events.map((event) => event.spellIndex)).toEqual(
      Array.from({ length: 26 }, (_, i) => i),
    );
    for (let index = 0; index < 26; index += 1) {
      expect(events[index]).toMatchObject({
        at: windowEnd(floorOf(BOOK[0].text) + index * 300),
        spellIndex: index,
        damage: damageOf(spellAt(BOOK, index)!.text),
      });
    }
    expect(await h.player('a')).toMatchObject({ spell_index: 26, spells_cast: 26 });
    const dealt = Array.from({ length: 26 }, (_, i) => damageOf(spellAt(BOOK, i)!.text));
    expect(await h.player('b')).toMatchObject({
      hp: 1_000_000 - dealt.reduce((sum, value) => sum + value, 0),
    });
    expect(await h.player('a')).toMatchObject({ hp: 1_000_000 });
  });
});

describe('资源窗口与失权', () => {
  it('同连接第 61 个 input 恰好一次 4004：废除所有权、关闭传输、计数一次、无战斗效果；可重连且非弃赛', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await h.send('a', await h.frame('a')); // 第 1 个：过早完成，代际推进
    for (let attempt = 0; attempt < 59; attempt += 1) {
      await h.send('a', await h.frame('a', 'AB', { draftEpoch: 0 })); // 第 2–60 个：旧代际重放
    }
    await h.send('a', await h.frame('a')); // 第 61 个：超限

    expect(h.sockets.a.closes).toEqual([
      { code: WS_CLOSE.inputOverload, reason: 'input overload' },
    ]);
    expect(await h.player('a')).toMatchObject({
      input_overloads: 1, // 计一次，不随重放增长
      conn_id: null,
      draft_epoch: 1, // 草稿与资格原样保留
      input_reset_reason: 'completion_too_early',
      input_opened_at: T0,
      input_not_before: T0 + floorOf(BOOK[0].text),
    });
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
    expect(readEvents((await h.room())!)).toEqual([]);
    expect(await h.player('a')).toMatchObject({ hp: INITIAL_HEALTH });
    expect(await h.player('b')).toMatchObject({ hp: INITIAL_HEALTH });
    expect(h.sockets.b.closes).toEqual([]); // 没有面向全房的攻击或关闭
    expect(consoleErrors).toHaveBeenCalledTimes(1);
    expect(consoleErrors).toHaveBeenCalledWith({
      event: 'input_overload',
      matchId: MATCH_ID,
      policyVersion: INPUT_POLICY_VERSION,
      mode: 'enforce',
      reason: 'input_overload',
      count: 1,
    });

    // 资源关闭不是弃赛：新连接可接管，恢复路径完整，没有离场记录。
    expect(await abandonedMatch(h.db, ROOM_ID, 'a', MATCH_ID)).toBe(false);
    const reconnected = await h.takeover('a', 'a-conn2');
    await updatePlayer(h.db, ROOM_ID, 'a', {});
    expect((await h.snapshot('a')).selfInputGate).toMatchObject({
      draftEpoch: 1,
      resetReason: 'completion_too_early',
    });

    // 排队帧在关闭落地前到达：所有权已废，帧被替换路径拦下，不能二次计数或二次关闭。
    h.sockets.a.reopen();
    await h.sendAs('a', 'a-conn', await h.frame('a', 'A'));
    expect(await h.player('a')).toMatchObject({ input_overloads: 1 });
    expect(h.sockets.a.closes).toEqual([
      { code: WS_CLOSE.inputOverload, reason: 'input overload' },
      { code: WS_CLOSE.replaced, reason: 'superseded' },
    ]);
    expect(await h.player('a')).toMatchObject({ conn_id: 'a-conn2' });
    expect(reconnected.socket.readyState).toBe(1);
  });
});

describe('裁决时刻', () => {
  it('时钟在帧悬停的微任务间隙前进：门槛用悬停后的时刻裁决，新资格从该时刻起算', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    // 帧在 T+69 发出（此刻过早），裁决在悬停后的 T+70 进行：新鲜时钟放行。
    const pending = h.send('a', await h.frame('a'));
    h.at(70);
    await pending;

    expect(await h.player('a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
      draft_epoch: 0, // 不曾经历拒绝
      input_gate_hits: 0,
      input_opened_at: T0 + 70, // 新资格从裁决时刻起算，不从发帧时刻
      input_not_before: T0 + 70 + floorOf(BOOK[1].text),
    });
    expect((await readVolley(h.db, ROOM_ID))!.casts).toHaveLength(1);
  });

  it('时钟在帧悬停的微任务间隙跨过截止：悬停后的帧不得入队，比赛按原截止终局', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 - 1000 });
    h.at(MATCH_DURATION_MS - 50); // 门槛早已满足：若用悬停前的旧时刻就会入队
    const pending = h.send('a', await h.frame('a'));
    h.at(MATCH_DURATION_MS + 50); // 悬停间隙跨过比赛截止
    await pending;

    expect(await h.player('a')).toMatchObject({ spell_index: 0, spells_cast: 0 });
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
    expect(readEvents((await h.room())!)).toEqual([]);
    const room = (await h.room())!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('timeout');
    expect(room.ended_at).toBe(COMBAT_END); // 原截止，不是悬停后的时刻
  });

  it('时钟在帧悬停的微任务间隙跨过批次末：过期批次先独自落地，悬停的完成进入独立的新批次', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'observe', openedAt: T0 });
    h.at(70);
    await h.send('a', await h.frame('a')); // 第一批：窗口 [T0, T0+100]
    const expired = (await readVolley(h.db, ROOM_ID))!;
    expect(expired.endsAt).toBe(windowEnd(70));

    // 第二发在批次过期前发出，裁决悬停在微任务里，时钟跨过批次末：
    // 过期批次必须先结清，完成加入新窗口，绝不并入已过期的一批。
    const pending = h.send('a', await h.frame('a'));
    h.at(150);
    await pending;

    expect(await h.player('a')).toMatchObject({
      spell_index: 2,
      spells_cast: 2,
      input_opened_at: T0 + 150,
    });
    // 第一批恰好落地一次：一条事件，伤害只有第一发的份额。
    const settled = readEvents((await h.room())!);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      attackerId: 'a',
      targetId: 'b',
      damage: damageOf(BOOK[0].text),
      at: windowEnd(70),
    });
    expect(await h.player('b')).toMatchObject({
      hp: INITIAL_HEALTH - damageOf(BOOK[0].text),
    });
    // 悬停的完成在下一个窗口独自等待：只有它自己，末时刻是它自己的窗口。
    const next = (await readVolley(h.db, ROOM_ID))!;
    expect(next.casts).toEqual([
      { attackerId: 'a', spellIndex: 1, element: 'arcane', power: damageOf(BOOK[1].text) },
    ]);
    expect(next.endsAt).toBe(windowEnd(150));

    h.at(200);
    await advanceOnce(h.scope);
    const all = readEvents((await h.room())!);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ damage: damageOf(BOOK[1].text), at: windowEnd(150) });
    expect(await h.player('b')).toMatchObject({
      hp: INITIAL_HEALTH - damageOf(BOOK[0].text) - damageOf(BOOK[1].text),
    });
  });
});

describe('持久、接管与策略锁定', () => {
  it('草稿与资格跨实例重开与连接接管原样保留：notBefore 不缩短、不重新计时', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spelltype-input-gate-restart-'));
    try {
      const first = await openDatabase(`pglite://${dir}`);
      await seedMatchRoom(first.db, ['a', 'b'], {
        mode: 'enforce',
        phase: 'playing',
        openedAt: T0,
        deadline: COMBAT_END,
      });
      await updatePlayer(first.db, ROOM_ID, 'a', {
        progress: 1,
        last_input: 'A',
        attempt_total: 1,
      });
      await first.close(); // 整个实例连同连接一起关闭

      const reopened = await openDatabase(`pglite://${dir}`);
      databases.push(reopened);
      const h = await buildHarness(reopened.db, ['a', 'b'], 'enforce');
      const before = await h.player('a');
      expect(before).toMatchObject({
        last_input: 'A',
        progress: 1,
        attempt_total: 1,
        draft_epoch: 0,
        input_opened_at: T0,
        input_not_before: T0 + floorOf(BOOK[0].text),
      });

      // 第二连接接管：身份换了，资格与草稿一个字节都不变。
      await h.takeover('a', 'a-conn2');
      await updatePlayer(h.db, ROOM_ID, 'a', {});
      expect(await h.player('a')).toEqual({ ...before, conn_id: 'a-conn2' });

      h.at(70);
      await h.sendAs('a', 'a-conn2', await h.frame('a'));
      expect(await h.player('a')).toMatchObject({
        spell_index: 1,
        spells_cast: 1,
        input_opened_at: T0 + 70, // 恰在原始门槛时刻被接受：接管没有重新计时
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('重开不重算已锁策略；新局按当前环境重新锁定并清空摘要；配置异常拒绝开局', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spelltype-input-gate-policy-'));
    try {
      const file = await openDatabase(`pglite://${dir}`);
      await seedMatchRoom(file.db, ['a', 'b'], {
        mode: 'enforce',
        phase: 'playing',
        openedAt: T0,
        deadline: COMBAT_END,
      });
      await updatePlayer(file.db, ROOM_ID, 'a', {
        draft_epoch: 3,
        input_reset_reason: 'completion_too_early',
        input_gate_hits: 2,
        input_recoveries: 1,
        input_min_completion_ratio: 0.5,
        input_overloads: 1,
        input_recovered_completions: 1,
        input_recovery_departures: 1,
      });
      await file.close();

      // 新实例以 observe 为默认环境重启：活跃局的锁定策略与摘要一字不动。
      const reopened = await openDatabase(`pglite://${dir}`);
      databases.push(reopened);
      const h = await buildHarness(reopened.db, ['a', 'b'], 'observe');
      expect(await advanceOnce(h.scope)).toMatchObject({ progressed: false }); // 无事可做的读路径不重写任何值
      expect(await h.room()).toMatchObject({
        phase: 'playing',
        input_policy_version: INPUT_POLICY_VERSION,
        input_policy_mode: 'enforce',
        input_min_ms_per_code_point: INPUT_MIN_MS_PER_CODE_POINT,
      });
      expect(await h.player('a')).toMatchObject({
        draft_epoch: 3,
        input_opened_at: T0,
        input_not_before: T0 + floorOf(BOOK[0].text),
        input_gate_hits: 2,
        input_recoveries: 1,
        input_min_completion_ratio: 0.5,
        input_overloads: 1,
        input_recovered_completions: 1,
        input_recovery_departures: 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    // 新局：开局锁定当前环境模式，并把上一局的全部摘要与资格清零。
    const lobby = await lobbyHarness(['a', 'b']);
    await updatePlayer(lobby.db, ROOM_ID, 'a', {
      input_gate_hits: 9,
      input_recoveries: 8,
      input_overloads: 7,
      input_recovered_completions: 6,
      input_recovery_departures: 5,
      input_min_completion_ratio: 0.25,
      draft_epoch: 4,
      input_opened_at: T0,
      input_not_before: T0 + 70,
    });
    expect(await runStart(lobby.db, (await getRoom(lobby.db, ROOM_ID))!, 'observe')).toBe(true);
    expect(await getRoom(lobby.db, ROOM_ID)).toMatchObject({
      phase: 'generating',
      input_policy_version: INPUT_POLICY_VERSION,
      input_policy_mode: 'observe',
      input_min_ms_per_code_point: INPUT_MIN_MS_PER_CODE_POINT,
    });
    for (const row of await lobby.db.select().from(playersTable)) {
      expect(row).toMatchObject({
        hp: INITIAL_HEALTH,
        spell_index: 0,
        draft_epoch: 0,
        input_opened_at: null,
        input_not_before: null,
        input_reset_reason: null,
        input_sampled: 0,
        input_gate_hits: 0,
        input_recoveries: 0,
        input_min_completion_ratio: null,
        input_overloads: 0,
        input_recovered_completions: 0,
        input_recovery_departures: 0,
      });
    }

    // 无法识别的策略模式拒绝开局，绝不默认，也不碰任何座位。
    const invalid = await lobbyHarness(['a', 'b']);
    await updatePlayer(invalid.db, ROOM_ID, 'a', { hp: 7, input_gate_hits: 9 });
    expect(
      await runStart(invalid.db, (await getRoom(invalid.db, ROOM_ID))!, INVALID_POLICY_MODE),
    ).toBe(false);
    expect(await getRoom(invalid.db, ROOM_ID)).toMatchObject({
      phase: 'lobby',
      match_id: null,
      error: '施法规则配置异常，暂不能开始新对局。',
    });
    expect(await getPlayer(invalid.db, ROOM_ID, 'a')).toMatchObject({
      hp: 7,
      input_gate_hits: 9,
    });
  });
});

describe('状态损坏与边界', () => {
  it('资格或策略损坏的座位被同一句话拒绝：快照给 null gate 与明确错误，绝不当作零时刻就绪', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await updatePlayer(h.db, ROOM_ID, 'a', {
      input_not_before: T0 + floorOf(BOOK[0].text) + 1,
    }); // 与策略推导差 1ms

    let snapshot = await h.snapshot('a');
    expect(snapshot.selfInputGate).toBeNull();
    expect(snapshot.selfInputStats).toBeNull();
    expect(snapshot.error).toBe(INPUT_GATE_ERROR_MESSAGE);

    h.at(200);
    await h.send('a', await h.frame('a'));
    expect(h.sockets.a.sent.some((message) => message.type === 'error')).toBe(true);
    expect(await h.player('a')).toMatchObject({
      spell_index: 0,
      spells_cast: 0,
      draft_epoch: 0,
    });
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();

    // 非法锁定模式同样按损坏拒绝；修复后同一座位恢复可施法。
    await updateRoom(h.db, ROOM_ID, { input_policy_mode: INVALID_POLICY_MODE });
    expect((await h.snapshot('a')).selfInputGate).toBeNull();
    h.at(300);
    await h.send('a', await h.frame('a'));
    expect(await h.player('a')).toMatchObject({ spells_cast: 0 });

    await updateRoom(h.db, ROOM_ID, { input_policy_mode: 'enforce' });
    await updatePlayer(h.db, ROOM_ID, 'a', { input_not_before: T0 + floorOf(BOOK[0].text) });
    h.at(400);
    await h.send('a', await h.frame('a'));
    expect(await h.player('a')).toMatchObject({ spell_index: 1, spells_cast: 1 });
  });

  it('空书是状态损坏，不是免费零字施法', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await updateRoom(h.db, ROOM_ID, { spell_book: null });
    h.at(200);
    await h.send('a', await h.frame('a', 'AB'));

    expect(h.sockets.a.sent.some((message) => message.type === 'error')).toBe(true);
    expect(await h.player('a')).toMatchObject({
      spell_index: 0,
      spells_cast: 0,
      draft_epoch: 0,
      attempt_total: 0,
    });
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
    expect((await h.snapshot('a')).selfInputGate).toBeNull();
  });

  it('没有存活对手且无未结批次：完成立即按幸存者规则终局，不记录完成或恢复', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await updatePlayer(h.db, ROOM_ID, 'b', { hp: 0, eliminated_at: T0 });
    h.at(70);
    await h.send('a', await h.frame('a'));

    const room = (await h.room())!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('elimination');
    expect(room.ended_at).toBe(T0 + 70);
    expect(await h.player('a')).toMatchObject({
      spell_index: 0,
      spells_cast: 0,
      correct_chars: 0,
      input_recovered_completions: 0,
      input_gate_hits: 0,
    });
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
    expect(readEvents(room)).toEqual([]);
  });
});

describe('已提交批次与幸存者终局', () => {
  it('对手在批次未结时弃赛：完成只得到快照，不记录新施法；已提交批次到点恰好结算一次', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(70);
    await h.send('a', await h.frame('a')); // 已提交的攻击在窗口里等待
    h.at(80);
    await manualLeave(h.scope, 'b'); // 对手在窗口内弃赛：批次未结，对局保持 playing
    expect(await h.room()).toMatchObject({ phase: 'playing' });
    expect((await readVolley(h.db, ROOM_ID))!.casts).toHaveLength(1);

    h.at(90);
    await h.send('a', await h.frame('a')); // 无存活对手的完成：批次还悬着，只回快照
    expect(await h.player('a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1, // 不记录新完成
      draft_epoch: 0, // 不制造恢复
      input_recoveries: 0,
      input_gate_hits: 0,
      input_recovered_completions: 0,
    });
    expect((await readVolley(h.db, ROOM_ID))!.casts).toHaveLength(1); // 原有承诺不被追加或改写

    h.at(100);
    await advanceOnce(h.scope); // 批次到点：恰好结算一次并终局
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
    const room = (await h.room())!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('elimination');
    expect(room.ended_at).toBe(windowEnd(70));
    expect(readEvents(room)).toEqual([]); // 对手已弃赛：份额弃置，无事件
    expect(
      await h.db
        .select({ user_id: results.user_id, rank: results.rank, spells_cast: results.spells_cast })
        .from(results)
        .orderBy(results.user_id),
    ).toEqual([
      { user_id: 'a', rank: 1, spells_cast: 1 },
      { user_id: 'b', rank: 2, spells_cast: 0 },
    ]);
  });
});

describe('结算 await 期间的替换竞态', () => {
  it('输入悬在结算中时座位被替换：旧连接不落任何效果，只有已提交的批次落地一次', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'observe', openedAt: T0 });
    await updatePlayer(h.db, ROOM_ID, 'b', { hp: damageOf(BOOK[0].text) });

    h.at(70);
    await h.send('a', await h.frame('a')); // 致命一击入队，窗口末落地
    h.at(100);
    // 下一发完成帧先结清批次并进入终局；终局后的快照投递被闸住，
    // 就在这个间隙里，一条新连接接管了 a 的座位。
    const gate = {
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    };
    pushGate = gate;
    const pending = h.send('a', await h.frame('a'));
    try {
      await gate.entered.promise;
      await h.takeover('a', 'a-conn2');
    } finally {
      gate.release.resolve();
      await pending;
    }

    const room = (await h.room())!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('elimination');
    expect(room.ended_at).toBe(windowEnd(70)); // 按批次自己的时刻终局，不按迟到的续跑时刻
    // 只有悬停前已提交的那一发算数：替换后的旧帧什么都没有再落。
    expect(await h.player('a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
      draft_epoch: 0,
    });
    const events = readEvents(room);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      attackerId: 'a',
      targetId: 'b',
      damage: damageOf(BOOK[0].text),
      eliminated: true,
      at: windowEnd(70),
    });
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
    expect(
      await h.db
        .select({ user_id: results.user_id, rank: results.rank })
        .from(results)
        .orderBy(results.user_id),
    ).toEqual([
      { user_id: 'a', rank: 1 },
      { user_id: 'b', rank: 2 },
    ]);
    // 新连接读到的是终局权威状态；旧连接只会被替换路径收尾。
    expect((await h.snapshot('a')).phase).toBe('finished');
    expect(h.sockets.a.closes).toContainEqual({
      code: WS_CLOSE.replaced,
      reason: 'not the current connection',
    });
  });
});

describe('恢复指标', () => {
  it('恢复后未完成即离场计入 recovery_departures；完成后再离场不计', async () => {
    // 场景一：恢复过的当前咒语仍未完成，主动离场 —— 计一次。
    const left = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await left.send('b', await left.frame('b')); // b 过早完成：恢复代际 1
    expect(await hpof(left, 'b').then((row) => row.draft_epoch)).toBe(1);
    left.at(10);
    await manualLeave(left.scope, 'b');
    expect(
      await left.db
        .select({
          user_id: results.user_id,
          input_recovery_departures: results.input_recovery_departures,
          input_recovered_completions: results.input_recovered_completions,
        })
        .from(results)
        .orderBy(results.user_id),
    ).toEqual([
      { user_id: 'a', input_recovery_departures: 0, input_recovered_completions: 0 },
      { user_id: 'b', input_recovery_departures: 1, input_recovered_completions: 0 },
    ]);

    // 场景二：恢复后先把当前咒文补全（代际归零），再离场 —— 不计离场。
    const done = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await done.send('b', await done.frame('b')); // 过早：代际 1
    done.at(70);
    await done.send('b', await done.frame('b')); // 就绪补全：代际归零、恢复完成计一次
    expect(await done.player('b')).toMatchObject({
      draft_epoch: 0,
      input_recovered_completions: 1,
    });
    done.at(80);
    await manualLeave(done.scope, 'b');
    done.at(100);
    await advanceOnce(done.scope);
    expect(
      await done.db
        .select({
          user_id: results.user_id,
          input_recovery_departures: results.input_recovery_departures,
          input_recovered_completions: results.input_recovered_completions,
        })
        .from(results)
        .orderBy(results.user_id),
    ).toEqual([
      { user_id: 'a', input_recovery_departures: 0, input_recovered_completions: 0 },
      { user_id: 'b', input_recovery_departures: 0, input_recovered_completions: 1 },
    ]);
  });
});

async function hpof(h: Harness, userId: string): Promise<PlayerRow> {
  return h.player(userId);
}

it('部分输入不能绕过已被接管的运行时写入围栏', async () => {
  const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
  const owner = await acquireRuntime(h.db);
  const scope: RoomScope = {
    ...h.scope,
    transact: (fn) =>
      h.db.transaction(async (tx) => {
        await owner.assert(tx);
        return fn(tx);
      }),
  };
  try {
    await handleClientFrame(scope, h.sockets.a.socket, metaOf('a'), await h.frame('a', 'A'));
    const accepted = await h.player('a');
    expect(accepted).toMatchObject({ progress: 1, last_input: 'A', attempt_total: 1 });
    // 租约到期：过期租约永不复活，后来者取得更新代次，旧所有者的证明即刻失效。
    await h.db
      .update(runtimeControl)
      .set({ lease_until: 0 })
      .where(eq(runtimeControl.singleton, 1));
    const successor = await acquireRuntime(h.db);
    try {
      expect(
        handleClientFrame(scope, h.sockets.a.socket, metaOf('a'), await h.frame('a', 'AX')),
      ).rejects.toThrow(RuntimeOwnershipLostError);
      expect(await h.player('a')).toEqual(accepted);
    } finally {
      await successor.close();
    }
  } finally {
    await owner.close();
  }
});

describe('SQL 异常回滚', () => {
  it('开局事务中途失败：座位复位与策略锁定整体回滚，重跑成功', async () => {
    const lobby = await lobbyHarness(['a', 'b']);
    await updatePlayer(lobby.db, ROOM_ID, 'a', { hp: 7, input_gate_hits: 5, spells_cast: 3 });

    injection = { op: 'update', table: 'rooms' };
    expect(runStart(lobby.db, await roomSync(lobby.db), 'enforce')).rejects.toThrow(
      'injected sql failure',
    );
    injection = null;

    expect(await getRoom(lobby.db, ROOM_ID)).toMatchObject({
      phase: 'lobby',
      match_id: null,
      generation_token: null,
      error: null,
      input_policy_version: null,
    });
    expect(await getPlayer(lobby.db, ROOM_ID, 'a')).toMatchObject({
      hp: 7,
      input_gate_hits: 5,
      spells_cast: 3,
    });

    expect(await runStart(lobby.db, (await getRoom(lobby.db, ROOM_ID))!, 'enforce')).toBe(true);
    expect(await getRoom(lobby.db, ROOM_ID)).toMatchObject({
      phase: 'generating',
      input_policy_version: INPUT_POLICY_VERSION,
      input_policy_mode: 'enforce',
      input_min_ms_per_code_point: INPUT_MIN_MS_PER_CODE_POINT,
    });
    expect(await getPlayer(lobby.db, ROOM_ID, 'a')).toMatchObject({
      hp: INITIAL_HEALTH,
      input_gate_hits: 0,
      spells_cast: 0,
      draft_epoch: 0,
      input_opened_at: null,
    });
  });

  it('倒计时转换中途失败：资格写入与 playing 转换整体回滚，重跑按同一时刻就绪', async () => {
    const h = await countdownHarness(['a', 'b'], 'enforce');
    h.at(3_000);
    injection = { op: 'update', table: 'rooms' };
    expect(advanceOnce(h.scope)).rejects.toThrow('injected sql failure');
    injection = null;

    expect(await h.room()).toMatchObject({
      phase: 'countdown',
      started_at: null,
      deadline: T0 + 3_000,
    });
    for (const userId of ['a', 'b']) {
      expect(await h.player(userId)).toMatchObject({
        input_opened_at: null,
        input_not_before: null,
        draft_epoch: 0,
      });
    }

    expect(await advanceOnce(h.scope)).toMatchObject({ progressed: true });
    expect(await h.room()).toMatchObject({
      phase: 'playing',
      started_at: T0 + 3_000,
      deadline: T0 + 3_000 + MATCH_DURATION_MS,
    });
    expect(await h.player('a')).toMatchObject({
      input_opened_at: T0 + 3_000,
      input_not_before: T0 + 3_000 + floorOf(BOOK[0].text),
    });
  });

  it('接受完成中途失败：施法承诺与游标推进整体回滚，重发恰好接受一次', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(70);
    injection = { op: 'update', table: 'players' };
    expect(h.send('a', await h.frame('a'))).rejects.toThrow('injected sql failure');
    injection = null;

    expect(await readVolley(h.db, ROOM_ID)).toBeNull(); // 批次写入被回滚
    expect(await h.player('a')).toMatchObject({
      spell_index: 0,
      spells_cast: 0,
      correct_chars: 0,
      attempt_total: 0,
      input_opened_at: T0,
      input_not_before: T0 + floorOf(BOOK[0].text),
      draft_epoch: 0,
    });
    expect(await h.player('b')).toMatchObject({ hp: INITIAL_HEALTH });

    await h.send('a', await h.frame('a'));
    expect(await h.player('a')).toMatchObject({ spell_index: 1, spells_cast: 1 });
    expect((await readVolley(h.db, ROOM_ID))!.casts).toHaveLength(1);
  });

  it('结算中途失败：保留已接受承诺，伤害与终局整体回滚，恢复后按原窗口结算一次', async () => {
    const h = await playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await updatePlayer(h.db, ROOM_ID, 'a', { cpm: 7 }); // 哨兵：结算会重写 cpm，回滚必须还原它
    await updatePlayer(h.db, ROOM_ID, 'b', { hp: damageOf(BOOK[0].text) });
    h.at(70);
    await h.send('a', await h.frame('a'));
    const pending = await readVolley(h.db, ROOM_ID);
    expect(pending?.casts).toHaveLength(1);
    h.at(100);

    injection = { op: 'insert', table: 'results' };
    expect(advanceOnce(h.scope)).rejects.toThrow('injected sql failure');
    injection = null;

    // 接受已提交；伤害、事件、终局与承诺清除必须一起回滚。
    expect(await h.player('b')).toMatchObject({
      hp: damageOf(BOOK[0].text),
      eliminated_at: null,
    });
    expect(readEvents((await h.room())!)).toEqual([]);
    expect(await readVolley(h.db, ROOM_ID)).toEqual(pending);
    expect(await h.player('a')).toMatchObject({ spell_index: 1, spells_cast: 1, damage_dealt: 0 });
    expect(await h.room()).toMatchObject({
      phase: 'playing',
      ended_at: null,
      end_reason: null,
    });
    expect(
      await h.db
        .select({ user_id: results.user_id, rank: results.rank })
        .from(results)
        .orderBy(results.user_id),
    ).toEqual([]);
    expect(await h.player('a')).toMatchObject({ cpm: 7 });

    // 恢复后不重发输入，也不等比赛截止；旧承诺按原批次边界完成。
    h.at(200);
    expect(await advanceOnce(h.scope)).toMatchObject({ progressed: true });
    const room = (await h.room())!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('elimination');
    expect(room.ended_at).toBe(windowEnd(70));
    expect(readEvents(room)).toHaveLength(1);
    expect(await readVolley(h.db, ROOM_ID)).toBeNull();
    expect(
      await h.db
        .select({ user_id: results.user_id, rank: results.rank, cpm: results.cpm })
        .from(results)
        .orderBy(results.user_id),
    ).toEqual([
      { user_id: 'a', rank: 1, cpm: 1200 },
      { user_id: 'b', rank: 2, cpm: 0 },
    ]);
  });
});

/** The room row as the call sites in this suite need it, re-read fresh. */
function roomSync(db: Database): Promise<RoomRow> {
  return getRoom(db, ROOM_ID).then((room) => {
    if (!room) throw new Error('test room vanished');
    return room;
  });
}
