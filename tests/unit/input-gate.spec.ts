/**
 * 输入门槛 — 服务端施法时间门槛的验收回归。
 *
 * 每个用例驱动房间的公共入口（`handleClientFrame` → `handleInput`、`advanceOnce`、
 * `manualLeave`、`startMatch`、`snapshotFor`）打到真实 SQLite 上，时钟只经
 * `Date.now` 间谍控制。可观察契约（对应规格 AC-01–09、12–18 中可单测的部分）：
 * enforce 拒绝只推进代际并记录原因/采样，绝不入批次；acceptance 与资格、采样、
 * 游标在同一提交里，伤害与事件等窗口末的 advanceCombat 才落地；恢复计数只认
 * 当前咒文；资源窗口第 61 个合法 input 恰好一次废除所有权并 4004；策略在开局
 * 锁定、重开不重算、新局清零；损坏状态被同一句话拒绝且快照给 null gate；
 * 结算 await 期间的替换连接读不到任何东西；开局/倒计时转换/接受/结算四条路径
 * 的中途 SQL 异常各自整体回滚。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  COMBAT_BATCH_MS,
  INITIAL_HEALTH,
  MATCH_DURATION_MS,
  WS_CLOSE,
  WS_PROTOCOL,
  type RoomSnapshot,
  type ServerMessage,
  type Spell,
} from '../../shared/protocol';
import type { Env } from '../../worker/env';
import type { InputFrame } from '../../worker/rooms/combat';
import { handleClientFrame } from '../../worker/rooms/frames';
import { INPUT_GATE_ERROR_MESSAGE } from '../../worker/rooms/input-gate';
import { manualLeave } from '../../worker/rooms/leave';
import { startMatch } from '../../worker/rooms/match';
import { INPUT_MIN_MS_PER_CODE_POINT, INPUT_POLICY_VERSION } from '../../worker/rooms/rules';
import { InputBudget } from '../../worker/rooms/scope';
import type { RoomScope } from '../../worker/rooms/scope';
import { snapshotFor } from '../../worker/rooms/snapshots';
import type { SocketAuth } from '../../worker/rooms/sockets';
import { abandonedMatch } from '../../worker/rooms/storage/departures';
import { readEvents } from '../../worker/rooms/storage/events';
import type { PlayerRow, RoomRow } from '../../worker/rooms/storage/schema';
import { getPlayer, insertPlayer, updatePlayer } from '../../worker/rooms/storage/players';
import { getRoom, insertRoom, updateRoom } from '../../worker/rooms/storage/room';
import { createSchema } from '../../worker/rooms/storage/schema';
import { readSpellBook } from '../../worker/rooms/storage/spell-book';
import { readVolley } from '../../worker/rooms/storage/volley';
import { advanceOnce } from '../../worker/rooms/transitions';
import type { SqlStore } from '../../worker/sql';
import { charCount, damageOf, spellAt } from '../../worker/scoring';
import { openFileTestStorage, openTestStorage, type TestStorage } from '../support/sql-storage';

const T0 = 1_700_000_000_000;
const ROOM_ID = 'b'.repeat(24);
const MATCH_ID = 'match-gate';
const COMBAT_END = T0 + MATCH_DURATION_MS;
/** 座位不可能产出的锁定模式：锁定列只允许 observe/enforce，其余按损坏拒绝。 */
const INVALID_POLICY_MODE = 'normal' as unknown as 'observe';
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

interface StubSocket extends WebSocket {
  /** 测试里可写：模拟关闭落地前仍在投递排队帧的传输层。 */
  readyState: 0 | 1 | 2 | 3;
  sent: ServerMessage[];
  closes: { code: number; reason: string }[];
}

let now = T0;
let clock!: MockInstance;
let consoleErrors!: MockInstance;
const open: TestStorage[] = [];

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

function stubSocket(userId: string, connId = `${userId}-conn`): StubSocket {
  const sent: ServerMessage[] = [];
  const closes: { code: number; reason: string }[] = [];
  const ws = {
    // 传输层状态可写：模拟一个关闭尚未落地、仍在投递排队帧的传输层。
    readyState: WebSocket.OPEN as 0 | 1 | 2 | 3,
    sent,
    closes,
    deserializeAttachment: () => metaOf(userId, connId),
    send: (raw: string) => {
      sent.push(JSON.parse(raw) as ServerMessage);
    },
    close: (code: number, reason: string) => {
      closes.push({ code, reason });
      ws.readyState = WebSocket.CLOSED;
    },
  };
  // 只声明传输层用到的面；运行时对象即上述字面量。
  return ws as unknown as StubSocket;
}

function makeEnv(policyMode: string, batch?: (statements: unknown[]) => Promise<unknown>): Env {
  return {
    MATCH_ADMISSION: 'open',
    INPUT_POLICY_MODE: policyMode,
    DB: {
      prepare: () => ({ bind: () => ({}) }),
      batch: batch ?? (async () => ({})),
    },
  } as unknown as Env;
}

/**
 * 测试专用缝隙：scope 面向读者的 `readonly sql` 在故障注入时被整体换出再换回。
 * 回滚由 storage 自己的 transactionSync 完成，测试只提供会在真实 SQLite 上失败的语句。
 */
interface ScopeWithSwappableSql extends RoomScope {
  sql: SqlStore;
}

function failSqlOn(scope: ScopeWithSwappableSql, pattern: RegExp): () => void {
  const real = scope.sql;
  const exec = real.exec.bind(real);
  scope.sql = {
    exec: (query, ...bindings) => {
      if (pattern.test(query)) throw new Error(`injected sql failure: ${pattern.source}`);
      return exec(query, ...bindings);
    },
  };
  return () => {
    scope.sql = real;
  };
}

interface Harness {
  storage: TestStorage;
  scope: ScopeWithSwappableSql;
  sql: SqlStore;
  sockets: Record<string, StubSocket>;
  /** 挂一个新连接并把座位指给它（第二连接接管）。 */
  takeover(userId: string, connId: string): StubSocket;
  /** 按座位当前持久状态构造合法 input 帧；`overrides` 显式制造旧值。 */
  frame(
    userId: string,
    text?: string,
    overrides?: { matchId?: string; spellIndex?: number; draftEpoch?: number },
  ): InputFrame;
  /** 以座位的当前连接发送（正常路径）。 */
  send(userId: string, frame: InputFrame): Promise<void>;
  /** 以指定连接发送（接管后的新连接）。 */
  sendAs(userId: string, connId: string, frame: InputFrame): Promise<void>;
  /** 把时钟移到 T0 + offsetMs。 */
  at(offsetMs: number): void;
  snapshot(userId: string): RoomSnapshot;
  player(userId: string): PlayerRow;
  room(): RoomRow | null;
}

function buildHarness(storage: TestStorage, userIds: readonly string[], env: Env): Harness {
  const sockets: Record<string, StubSocket> = {};
  for (const userId of userIds) sockets[userId] = stubSocket(userId);
  const scope = {
    sql: storage.sql,
    env,
    input: new InputBudget(),
    alarm: { set: async () => {}, clear: async () => {} },
    sockets: () => Object.values(sockets),
    transactionSync: storage.transactionSync,
  } as ScopeWithSwappableSql;
  const socketFor = (userId: string, connId: string): StubSocket => {
    const key = connId === `${userId}-conn` ? userId : `${userId}:${connId}`;
    return sockets[key];
  };
  return {
    storage,
    scope,
    sql: storage.sql,
    sockets,
    takeover(userId, connId) {
      const ws = stubSocket(userId, connId);
      sockets[`${userId}:${connId}`] = ws;
      updatePlayer(storage.sql, userId, { conn_id: connId });
      return ws;
    },
    frame(userId, text, overrides) {
      const room = getRoom(storage.sql)!;
      const self = getPlayer(storage.sql, userId)!;
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
    },
    snapshot(userId) {
      return snapshotFor(scope, { id: userId, username: userId });
    },
    player(userId) {
      return getPlayer(storage.sql, userId)!;
    },
    room() {
      return getRoom(storage.sql)!;
    },
  };
}

function seedMatchRoom(
  storage: TestStorage,
  userIds: readonly string[],
  options: {
    mode: 'observe' | 'enforce';
    phase: 'countdown' | 'playing';
    openedAt: number | null;
    deadline: number;
  },
): void {
  createSchema(storage.sql);
  insertRoom(storage.sql, {
    id: ROOM_ID,
    hostId: userIds[0],
    mode: 'private',
    theme: '门槛契约',
    difficulty: 'hard',
    reservationState: 'none',
    reservationExpiresAt: null,
    now: T0,
  });
  updateRoom(storage.sql, {
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
  for (const userId of userIds) {
    insertPlayer(storage.sql, { userId, username: userId, slotExpiresAt: null, now: T0 });
    updatePlayer(storage.sql, userId, { seated: 1, conn_id: `${userId}-conn` });
    if (options.openedAt !== null) {
      // 首条咒语（下标 0）的资格；倒计时中的座位没有任何资格可预览。
      updatePlayer(storage.sql, userId, {
        input_opened_at: options.openedAt,
        input_not_before: options.openedAt + floorOf(BOOK[0].text),
      });
    }
  }
}

function playingHarness(
  userIds: readonly string[],
  options: { mode: 'observe' | 'enforce'; openedAt?: number },
): Harness {
  const storage = openTestStorage();
  open.push(storage);
  seedMatchRoom(storage, userIds, {
    mode: options.mode,
    phase: 'playing',
    openedAt: options.openedAt ?? T0,
    deadline: COMBAT_END,
  });
  return buildHarness(storage, userIds, makeEnv(options.mode));
}

function countdownHarness(userIds: readonly string[], env: Env): Harness {
  const storage = openTestStorage();
  open.push(storage);
  seedMatchRoom(storage, userIds, {
    mode: 'enforce',
    phase: 'countdown',
    openedAt: null,
    deadline: T0 + 3_000,
  });
  return buildHarness(storage, userIds, env);
}

function lobbyHarness(
  userIds: readonly string[],
  env: Env,
): { storage: TestStorage; scope: ScopeWithSwappableSql; sql: SqlStore } {
  const storage = openTestStorage();
  open.push(storage);
  createSchema(storage.sql);
  insertRoom(storage.sql, {
    id: ROOM_ID,
    hostId: userIds[0],
    mode: 'private',
    theme: '门槛契约',
    difficulty: 'hard',
    reservationState: 'none',
    reservationExpiresAt: null,
    now: T0,
  });
  for (const userId of userIds) {
    insertPlayer(storage.sql, { userId, username: userId, slotExpiresAt: null, now: T0 });
    updatePlayer(storage.sql, userId, { seated: 1, conn_id: `${userId}-conn`, ready: 1 });
  }
  const scope = {
    sql: storage.sql,
    env,
    input: new InputBudget(),
    alarm: { set: async () => {}, clear: async () => {} },
    sockets: () => [],
    transactionSync: storage.transactionSync,
  } as ScopeWithSwappableSql;
  return { storage, scope, sql: storage.sql };
}

/** 结算批次里在 `atMs` 提交的施法所属窗口的末时刻。 */
function windowEnd(atMs: number): number {
  return T0 + Math.floor(atMs / COMBAT_BATCH_MS) * COMBAT_BATCH_MS + COMBAT_BATCH_MS;
}

function resultRows(sql: SqlStore, columns: string): Array<Record<string, number | string | null>> {
  return sql
    .exec<Record<string, number | string | null>>(
      `SELECT user_id, ${columns} FROM match_results ORDER BY user_id`,
    )
    .toArray();
}

beforeEach(() => {
  now = T0;
  clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  consoleErrors = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  clock.mockRestore();
  consoleErrors.mockRestore();
  for (const storage of open.splice(0)) storage.close();
});

describe('enforce 门槛与恢复', () => {
  it('开局瞬发整段完成被拒：血量/事件/游标/完成数不动，代际 +1 并记录原因与首次采样', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await h.send('a', h.frame('a'));

    expect(h.player('a')).toMatchObject({
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
    expect(h.player('b').hp).toBe(INITIAL_HEALTH);
    expect(readEvents(h.room()!)).toEqual([]);
    expect(readVolley(h.sql)).toBeNull();

    const snapshot = h.snapshot('a');
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
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(30);
    await h.send('a', h.frame('a', 'AX')); // 含一个错误字符的草稿被正常接受
    expect(h.player('a')).toMatchObject({
      last_input: 'AX',
      progress: 1,
      attempt_total: 2,
      error_total: 1,
    });

    h.at(69);
    await h.send('a', h.frame('a')); // 门槛前完成：被拒，草稿与统计精确回原样
    expect(h.player('a')).toMatchObject({
      draft_epoch: 1,
      last_input: 'AX',
      progress: 1,
      attempt_total: 2,
      error_total: 1,
      input_recoveries: 1,
      input_recovered_completions: 0,
    });
    const snapshot = h.snapshot('a');
    expect(snapshot.selfInput).toBe('AX');
    expect(snapshot.selfInputStats).toEqual({ attemptTotal: 2, errorTotal: 1 });

    h.at(70);
    await h.send('a', h.frame('a')); // 新代际、门槛恰满足：一次命中
    expect(h.player('a')).toMatchObject({
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
    expect(h.player('b').hp).toBe(INITIAL_HEALTH - damageOf(BOOK[0].text));
    expect(readEvents(h.room()!)).toHaveLength(1);
  });

  it('门槛边界：T+69 拒、新代际在 T+70 恰好命中一次', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(69);
    await h.send('a', h.frame('a'));
    expect(h.player('a')).toMatchObject({ draft_epoch: 1, spells_cast: 0 });
    expect(readVolley(h.sql)).toBeNull();

    h.at(70);
    await h.send('a', h.frame('a'));
    const volley = readVolley(h.sql)!;
    expect(volley.casts).toEqual([
      { attackerId: 'a', spellIndex: 0, element: 'fire', power: damageOf(BOOK[0].text) },
    ]);
    expect(volley.endsAt).toBe(windowEnd(70));
  });

  it('恢复后只接受草稿不产生施法，跨过门槛也没有自动攻击，真正补全才命中一次', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(69);
    await h.send('a', h.frame('a'));
    h.at(70);
    await h.send('a', h.frame('a', 'A')); // 新代际的部分草稿：只更新快照
    expect(h.player('a')).toMatchObject({
      last_input: 'A',
      progress: 1,
      attempt_total: 1,
      spell_index: 0,
      spells_cast: 0,
    });
    expect(readVolley(h.sql)).toBeNull();

    h.at(500); // 时间自己跨过门槛：没有任何自动提交或攻击
    await advanceOnce(h.scope);
    expect(readVolley(h.sql)).toBeNull();
    expect(readEvents(h.room()!)).toEqual([]);
    expect(h.player('a').spells_cast).toBe(0);

    await h.send('a', h.frame('a')); // 用户真正补全：一次入队
    expect(h.player('a')).toMatchObject({ spell_index: 1, spells_cast: 1 });
    h.at(600);
    await advanceOnce(h.scope);
    expect(readEvents(h.room()!).map((event) => [event.attackerId, event.spellIndex])).toEqual([
      ['a', 0],
    ]);
    expect(h.player('b').hp).toBe(INITIAL_HEALTH - damageOf(BOOK[0].text));
  });

  it('拒绝后旧代际的重复补全/编辑不再改变任何状态；伪造 observe 模式也无法绕过 enforce', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(69);
    await h.send('a', h.frame('a'));
    const rejected = h.player('a');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await h.send('a', h.frame('a', 'AB', { draftEpoch: 0 }));
      await h.send('a', h.frame('a', 'AXQ', { draftEpoch: 0 }));
    }
    expect(h.player('a')).toEqual(rejected);
    expect(readVolley(h.sql)).toBeNull();
    expect(readEvents(h.room()!)).toEqual([]);

    // 帧内伪造 observe 模式与零成本：裁决只认房内锁定策略，仍被拒并推进代际。
    const forged = {
      ...h.frame('a', 'AB', { draftEpoch: 1 }),
      mode: 'observe',
      input_min_ms_per_code_point: 0,
    } as unknown as InputFrame; // 协议之外的字段由 schema 剥离，这里直接证明裁决不读它们
    h.at(69);
    await h.send('a', forged);
    expect(h.player('a')).toMatchObject({
      draft_epoch: 2,
      input_recoveries: 2,
      spells_cast: 0,
      input_opened_at: T0,
    });
  });

  it('持久化的 epoch 已达安全整数上限：座位按损坏拒绝（null gate 与明确错误），绝不自增、回绕或伪装就绪', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    updatePlayer(h.sql, 'a', { draft_epoch: Number.MAX_SAFE_INTEGER });

    // 上限代际是损坏的持久状态：快照不再发布看似健康的 gate，客户端停止提交。
    const snapshot = h.snapshot('a');
    expect(snapshot.selfInputGate).toBeNull();
    expect(snapshot.selfInputStats).toBeNull();
    expect(snapshot.error).toBe(INPUT_GATE_ERROR_MESSAGE);

    h.at(69);
    await h.send('a', h.frame('a'));
    expect(h.player('a')).toMatchObject({
      draft_epoch: Number.MAX_SAFE_INTEGER, // 不自增、不回绕
      input_recoveries: 0,
      input_gate_hits: 0,
      input_reset_reason: null,
    });
    h.at(70); // 即便时刻门槛已满足，损坏的座位也不接受
    await h.send('a', h.frame('a'));
    expect(h.player('a')).toMatchObject({
      draft_epoch: Number.MAX_SAFE_INTEGER,
      spell_index: 0,
      spells_cast: 0,
    });
    expect(readVolley(h.sql)).toBeNull();
    expect(readEvents(h.room()!)).toEqual([]);
  });
});

describe('observe 观察模式', () => {
  it('同样的过早整段完成照常命中并记录 gate hit、0 恢复；伪造 enforce 字段不改变观察行为', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'observe', openedAt: T0 });
    await h.send('a', h.frame('a'));
    expect(h.player('a')).toMatchObject({
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
      ...h.frame('a'),
      mode: 'enforce',
      input_min_ms_per_code_point: 0,
    } as unknown as InputFrame; // 同上：裁决只读房内锁定策略
    await h.send('a', forged);
    expect(h.player('a')).toMatchObject({
      spell_index: 2,
      spells_cast: 2,
      input_gate_hits: 2,
      input_recoveries: 0,
    });

    h.at(100);
    await advanceOnce(h.scope);
    const expectedDamage = damageOf(BOOK[0].text) + damageOf(BOOK[1].text);
    expect(h.player('b').hp).toBe(INITIAL_HEALTH - expectedDamage);
    expect(h.snapshot('a').selfInputGate?.mode).toBe('observe');
  });
});

describe('资格来源与开局', () => {
  it('资格在进入对局时已发布：首帧到达前快照可见，首帧迟到不重建开启时刻', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(69);
    // 首帧尚未到达，门槛已在开启时刻被计算：差 1ms 就绪。
    expect(h.snapshot('a').selfInputGate).toMatchObject({ notBefore: T0 + floorOf(BOOK[0].text) });

    h.at(70);
    await h.send('a', h.frame('a')); // 若按首帧时刻重建，此刻不可能就绪
    expect(h.player('a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
      input_opened_at: T0 + 70,
    });
  });

  it('倒计时中的预览输入无效：不写资格、不入队、不推进', async () => {
    const h = countdownHarness(['a', 'b'], makeEnv('enforce'));
    h.at(1_000);
    await h.send('a', {
      type: 'input',
      matchId: MATCH_ID,
      spellIndex: 0,
      draftEpoch: 0,
      text: BOOK[0].text,
    });

    expect(h.room()!.phase).toBe('countdown');
    expect(h.player('a')).toMatchObject({
      input_opened_at: null,
      input_not_before: null,
      draft_epoch: 0,
      spell_index: 0,
      spells_cast: 0,
      hp: INITIAL_HEALTH,
    });
    expect(readVolley(h.sql)).toBeNull();
  });

  it('registerDuel 拖延：资格按恢复后的真实时间计算，比赛时钟仍按原截止', async () => {
    const gate = Promise.withResolvers<void>();
    const h = countdownHarness(
      ['a', 'b'],
      makeEnv('enforce', async () => {
        await gate.promise;
        return {};
      }),
    );
    h.at(3_000); // 倒计时截止已到，轮到转换运行
    const run = advanceOnce(h.scope);
    h.at(3_500); // 索引写入悬在途中的真实延迟
    gate.resolve();
    expect(await run).toBe(true);

    expect(h.room()).toMatchObject({
      phase: 'playing',
      started_at: T0 + 3_000, // 开局时刻是原倒计时截止，不因拖延后移
      deadline: T0 + 3_000 + MATCH_DURATION_MS,
    });
    for (const userId of ['a', 'b']) {
      expect(h.player(userId)).toMatchObject({
        input_opened_at: T0 + 3_500, // 资格按恢复后的时间起算
        input_not_before: T0 + 3_500 + floorOf(BOOK[0].text),
      });
    }
    const snapshot = h.snapshot('a');
    expect(snapshot.phase).toBe('playing');
    expect(snapshot.selfInputGate).toMatchObject({
      mode: 'enforce',
      draftEpoch: 0,
      notBefore: T0 + 3_500 + floorOf(BOOK[0].text),
    });
  });

  it('已错过整场比赛的倒计时：转入即按原截止超时终局，不产生可操作的对局', async () => {
    const h = countdownHarness(['a', 'b'], makeEnv('enforce'));
    h.at(3_000 + MATCH_DURATION_MS + 1_000); // alarm 迟到：整场比赛时间都已耗尽
    expect(await advanceOnce(h.scope)).toBe(true);

    const room = h.room()!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('timeout');
    expect(room.started_at).toBe(T0 + 3_000); // 比赛时钟固定在原截止推导，不因晚 alarm 延长
    expect(room.ended_at).toBe(T0 + 3_000 + MATCH_DURATION_MS);
    expect(readVolley(h.sql)).toBeNull();
    expect(readEvents(room)).toEqual([]);
    // 双方都满血活到终局：生存并列共享第一。
    expect(resultRows(h.sql, 'rank')).toEqual([
      { user_id: 'a', rank: 1 },
      { user_id: 'b', rank: 1 },
    ]);
  });
});

describe('重放、游标与循环', () => {
  it('重复完成、旧下标与旧比赛帧只生效一次', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'observe', openedAt: T0 });
    await h.send('a', h.frame('a'));
    const accepted = h.player('a');
    expect(accepted).toMatchObject({ spell_index: 1, spells_cast: 1 });

    await h.send('a', h.frame('a', 'AB', { spellIndex: 0 })); // 完全相同的旧帧重放
    await h.send('a', h.frame('a', 'XX', { spellIndex: 0 })); // 旧下标携带不同文本
    await h.send('a', h.frame('a', 'AB', { matchId: 'match-0' })); // 旧比赛
    expect(h.player('a')).toEqual(accepted);
    expect(readVolley(h.sql)!.casts).toHaveLength(1);

    h.at(100);
    await advanceOnce(h.scope);
    expect(readEvents(h.room()!)).toHaveLength(1);
    expect(h.player('b').hp).toBe(INITIAL_HEALTH - damageOf(BOOK[0].text));
  });

  it('同刻完成下一条被拒：新法术的新资格不继承旧时刻', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(70);
    await h.send('a', h.frame('a'));
    expect(h.player('a')).toMatchObject({
      spell_index: 1,
      input_opened_at: T0 + 70,
      input_not_before: T0 + 70 + floorOf(BOOK[1].text), // T0+175
    });

    await h.send('a', h.frame('a')); // 同一刻完成第二条：被拒
    expect(h.player('a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
      draft_epoch: 1,
      input_reset_reason: 'completion_too_early',
      input_opened_at: T0 + 70, // 资格不被拒绝改写
      input_not_before: T0 + 175,
    });
    expect(readVolley(h.sql)!.casts).toHaveLength(1);
  });

  it('跨过整本书循环：下标单调递增，新资格按各法术长度隔离，全程零恢复', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    updatePlayer(h.sql, 'a', { hp: 1_000_000 });
    updatePlayer(h.sql, 'b', { hp: 1_000_000 });

    let acceptAt = floorOf(BOOK[0].text); // 首条恰在门槛时刻完成
    for (let index = 0; index < 26; index += 1) {
      h.at(acceptAt);
      await h.send('a', h.frame('a'));
      const a = h.player('a');
      expect(a.spell_index).toBe(index + 1); // 身份单调，从不对 24 取模
      expect(a.input_opened_at).toBe(T0 + acceptAt);
      const next = spellAt(BOOK, index + 1)!;
      expect(a.input_not_before).toBe(T0 + acceptAt + floorOf(next.text));
      expect(a).toMatchObject({ input_gate_hits: 0, input_recoveries: 0, spells_cast: index + 1 });

      // 本轮施法还在窗口里等待：已落地的只有之前各轮的批次。
      const events = readEvents(h.room()!);
      expect(events.map((event) => event.spellIndex)).toEqual(
        Array.from({ length: index }, (_, i) => i),
      );
      acceptAt += 300; // 每轮都跨过 100ms 窗口与最长门槛（210ms）
    }

    // 最后一窗到点：26 条批次各自按自己的窗口末恰好落地一次。
    h.at(acceptAt);
    await advanceOnce(h.scope);
    const events = readEvents(h.room()!);
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
    expect(h.player('a')).toMatchObject({ spell_index: 26, spells_cast: 26 });
    const dealt = Array.from({ length: 26 }, (_, i) => damageOf(spellAt(BOOK, i)!.text));
    expect(h.player('b').hp).toBe(1_000_000 - dealt.reduce((sum, value) => sum + value, 0));
    expect(h.player('a').hp).toBe(1_000_000);
  });
});

describe('资源窗口与失权', () => {
  it('同连接第 61 个 input 恰好一次 4004：废除所有权、关闭传输、计数一次、无战斗效果；可重连且非弃赛', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await h.send('a', h.frame('a')); // 第 1 个：过早完成，代际推进
    for (let attempt = 0; attempt < 59; attempt += 1) {
      await h.send('a', h.frame('a', 'AB', { draftEpoch: 0 })); // 第 2–60 个：旧代际重放，照常占窗
    }
    await h.send('a', h.frame('a')); // 第 61 个：超限

    expect(h.sockets.a.closes).toEqual([
      { code: WS_CLOSE.inputOverload, reason: 'input overload' },
    ]);
    expect(h.player('a')).toMatchObject({
      input_overloads: 1, // 计一次，不随重放增长
      conn_id: null,
      draft_epoch: 1, // 草稿与资格原样保留
      input_reset_reason: 'completion_too_early',
      input_opened_at: T0,
      input_not_before: T0 + floorOf(BOOK[0].text),
    });
    expect(readVolley(h.sql)).toBeNull();
    expect(readEvents(h.room()!)).toEqual([]);
    expect(h.player('a').hp).toBe(INITIAL_HEALTH);
    expect(h.player('b').hp).toBe(INITIAL_HEALTH);
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
    expect(abandonedMatch(h.sql, 'a', MATCH_ID)).toBe(false);
    const reconnected = h.takeover('a', 'a-conn2');
    expect(h.snapshot('a').selfInputGate).toMatchObject({
      draftEpoch: 1,
      resetReason: 'completion_too_early',
    });

    // 排队帧在关闭落地前到达：所有权已废，帧被替换路径拦下，不能二次计数或二次关闭。
    h.sockets.a.readyState = WebSocket.OPEN;
    await h.send('a', h.frame('a', 'A'));
    expect(h.player('a').input_overloads).toBe(1);
    expect(h.sockets.a.closes).toEqual([
      { code: WS_CLOSE.inputOverload, reason: 'input overload' },
      { code: WS_CLOSE.replaced, reason: 'superseded' },
    ]);
    expect(h.player('a').conn_id).toBe('a-conn2');
    expect(reconnected.readyState).toBe(WebSocket.OPEN);
  });
});

describe('裁决时刻', () => {
  it('时钟在帧悬停的微任务间隙前进：门槛用悬停后的时刻裁决，新资格从该时刻起算', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    // 帧在 T+69 发出（此刻过早），裁决在悬停后的 T+70 进行：新鲜时钟放行。
    const pending = h.send('a', h.frame('a'));
    h.at(70);
    await pending;

    expect(h.player('a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
      draft_epoch: 0, // 不曾经历拒绝
      input_gate_hits: 0,
      input_opened_at: T0 + 70, // 新资格从裁决时刻起算，不从发帧时刻
      input_not_before: T0 + 70 + floorOf(BOOK[1].text),
    });
    expect(readVolley(h.sql)!.casts).toHaveLength(1);
  });

  it('时钟在帧悬停的微任务间隙跨过截止：悬停后的帧不得入队，比赛按原截止终局', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 - 1000 });
    h.at(MATCH_DURATION_MS - 50); // 门槛早已满足：若用悬停前的旧时刻就会入队
    const pending = h.send('a', h.frame('a'));
    h.at(MATCH_DURATION_MS + 50); // 悬停间隙跨过比赛截止
    await pending;

    expect(h.player('a')).toMatchObject({ spell_index: 0, spells_cast: 0 });
    expect(readVolley(h.sql)).toBeNull();
    expect(readEvents(h.room()!)).toEqual([]);
    const room = h.room()!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('timeout');
    expect(room.ended_at).toBe(COMBAT_END); // 原截止，不是悬停后的时刻
  });

  it('时钟在帧悬停的微任务间隙跨过批次末：过期批次先独自落地，悬停的完成进入独立的新批次', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'observe', openedAt: T0 });
    h.at(70);
    await h.send('a', h.frame('a')); // 第一批：窗口 [T0, T0+100]
    const expired = readVolley(h.sql)!;
    expect(expired.endsAt).toBe(windowEnd(70));

    // 第二发在批次过期前发出，裁决悬停在微任务里，时钟跨过批次末：
    // 过期批次必须先结清，完成加入新窗口，绝不并入已过期的一批。
    const pending = h.send('a', h.frame('a'));
    h.at(150);
    await pending;

    expect(h.player('a')).toMatchObject({
      spell_index: 2,
      spells_cast: 2,
      input_opened_at: T0 + 150,
    });
    // 第一批恰好落地一次：一条事件，伤害只有第一发的份额。
    const settled = readEvents(h.room()!);
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      attackerId: 'a',
      targetId: 'b',
      damage: damageOf(BOOK[0].text),
      at: windowEnd(70),
    });
    expect(h.player('b').hp).toBe(INITIAL_HEALTH - damageOf(BOOK[0].text));
    // 悬停的完成在下一个窗口独自等待：只有它自己，末时刻是它自己的窗口。
    const next = readVolley(h.sql)!;
    expect(next.casts).toEqual([
      { attackerId: 'a', spellIndex: 1, element: 'arcane', power: damageOf(BOOK[1].text) },
    ]);
    expect(next.endsAt).toBe(windowEnd(150));

    h.at(200);
    await advanceOnce(h.scope);
    const all = readEvents(h.room()!);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({
      damage: damageOf(BOOK[1].text),
      at: windowEnd(150),
    });
    expect(h.player('b').hp).toBe(INITIAL_HEALTH - damageOf(BOOK[0].text) - damageOf(BOOK[1].text));
  });
});

describe('持久、接管与策略锁定', () => {
  it('草稿与资格跨实例重开与连接接管原样保留：notBefore 不缩短、不重新计时', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spelltype-input-gate-restart-'));
    try {
      const first = openFileTestStorage(join(dir, 'room.sqlite'));
      open.push(first);
      seedMatchRoom(first, ['a', 'b'], {
        mode: 'enforce',
        phase: 'playing',
        openedAt: T0,
        deadline: COMBAT_END,
      });
      updatePlayer(first.sql, 'a', { progress: 1, last_input: 'A', attempt_total: 1 });
      first.close(); // 整个实例连同连接一起关闭
      open.splice(open.indexOf(first), 1);

      const reopened = openFileTestStorage(join(dir, 'room.sqlite'));
      open.push(reopened);
      createSchema(reopened.sql); // 幂等重建
      const h = buildHarness(reopened, ['a', 'b'], makeEnv('enforce'));
      const before = h.player('a');
      expect(before).toMatchObject({
        last_input: 'A',
        progress: 1,
        attempt_total: 1,
        draft_epoch: 0,
        input_opened_at: T0,
        input_not_before: T0 + floorOf(BOOK[0].text),
      });

      // 第二连接接管：身份换了，资格与草稿一个字节都不变。
      h.takeover('a', 'a-conn2');
      expect(h.player('a')).toEqual({ ...before, conn_id: 'a-conn2' });

      h.at(70);
      await h.sendAs('a', 'a-conn2', h.frame('a'));
      expect(h.player('a')).toMatchObject({
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
      const file = openFileTestStorage(join(dir, 'room.sqlite'));
      open.push(file);
      seedMatchRoom(file, ['a', 'b'], {
        mode: 'enforce',
        phase: 'playing',
        openedAt: T0,
        deadline: COMBAT_END,
      });
      updatePlayer(file.sql, 'a', {
        draft_epoch: 3,
        input_reset_reason: 'completion_too_early',
        input_gate_hits: 2,
        input_recoveries: 1,
        input_min_completion_ratio: 0.5,
        input_overloads: 1,
        input_recovered_completions: 1,
        input_recovery_departures: 1,
      });
      file.close();
      open.splice(open.indexOf(file), 1);

      // 新实例以 observe 为默认环境重启：活跃局的锁定策略与摘要一字不动。
      const reopened = openFileTestStorage(join(dir, 'room.sqlite'));
      open.push(reopened);
      createSchema(reopened.sql); // 幂等重建；活跃局已带策略，不得要求排空
      const h = buildHarness(reopened, ['a', 'b'], makeEnv('observe'));
      expect(await advanceOnce(h.scope)).toBe(false); // 无事可做的读路径不重写任何值
      expect(h.room()).toMatchObject({
        phase: 'playing',
        input_policy_version: INPUT_POLICY_VERSION,
        input_policy_mode: 'enforce',
        input_min_ms_per_code_point: INPUT_MIN_MS_PER_CODE_POINT,
      });
      expect(h.player('a')).toMatchObject({
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
    const lobby = lobbyHarness(['a', 'b'], makeEnv('observe'));
    updatePlayer(lobby.sql, 'a', {
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
    expect(startMatch(lobby.scope, getRoom(lobby.sql)!)).toBe(true);
    expect(getRoom(lobby.sql)!).toMatchObject({
      phase: 'generating',
      input_policy_version: INPUT_POLICY_VERSION,
      input_policy_mode: 'observe',
      input_min_ms_per_code_point: INPUT_MIN_MS_PER_CODE_POINT,
    });
    for (const row of lobby.sql.exec<PlayerRow>('SELECT * FROM players').toArray()) {
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
    const invalid = lobbyHarness(['a', 'b'], makeEnv('fast'));
    updatePlayer(invalid.sql, 'a', { hp: 7, input_gate_hits: 9 });
    expect(startMatch(invalid.scope, getRoom(invalid.sql)!)).toBe(false);
    expect(getRoom(invalid.sql)!).toMatchObject({
      phase: 'lobby',
      match_id: null,
      error: '施法规则配置异常，暂不能开始新对局。',
    });
    expect(getPlayer(invalid.sql, 'a')).toMatchObject({ hp: 7, input_gate_hits: 9 });
  });
});

describe('状态损坏与边界', () => {
  it('资格或策略损坏的座位被同一句话拒绝：快照给 null gate 与明确错误，绝不当作零时刻就绪', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    updatePlayer(h.sql, 'a', { input_not_before: T0 + floorOf(BOOK[0].text) + 1 }); // 与策略推导差 1ms

    let snapshot = h.snapshot('a');
    expect(snapshot.selfInputGate).toBeNull();
    expect(snapshot.selfInputStats).toBeNull();
    expect(snapshot.error).toBe(INPUT_GATE_ERROR_MESSAGE);

    h.at(200);
    await h.send('a', h.frame('a'));
    expect(h.sockets.a.sent.some((message) => message.type === 'error')).toBe(true);
    expect(h.player('a')).toMatchObject({ spell_index: 0, spells_cast: 0, draft_epoch: 0 });
    expect(readVolley(h.sql)).toBeNull();

    // 非法锁定模式同样按损坏拒绝；修复后同一座位恢复可施法。
    updateRoom(h.sql, { input_policy_mode: INVALID_POLICY_MODE });
    expect(h.snapshot('a').selfInputGate).toBeNull();
    h.at(300);
    await h.send('a', h.frame('a'));
    expect(h.player('a').spells_cast).toBe(0);

    updateRoom(h.sql, { input_policy_mode: 'enforce' });
    updatePlayer(h.sql, 'a', { input_not_before: T0 + floorOf(BOOK[0].text) });
    h.at(400);
    await h.send('a', h.frame('a'));
    expect(h.player('a')).toMatchObject({ spell_index: 1, spells_cast: 1 });
  });

  it('空书是状态损坏，不是免费零字施法', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    updateRoom(h.sql, { spell_book: null });
    h.at(200);
    await h.send('a', h.frame('a', 'AB'));

    expect(h.sockets.a.sent.some((message) => message.type === 'error')).toBe(true);
    expect(h.player('a')).toMatchObject({
      spell_index: 0,
      spells_cast: 0,
      draft_epoch: 0,
      attempt_total: 0,
    });
    expect(readVolley(h.sql)).toBeNull();
    expect(h.snapshot('a').selfInputGate).toBeNull();
  });

  it('没有存活对手且无未结批次：完成立即按幸存者规则终局，不记录完成或恢复', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    updatePlayer(h.sql, 'b', { hp: 0, eliminated_at: T0 });
    h.at(70);
    await h.send('a', h.frame('a'));

    const room = h.room()!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('elimination');
    expect(room.ended_at).toBe(T0 + 70);
    expect(h.player('a')).toMatchObject({
      spell_index: 0,
      spells_cast: 0,
      correct_chars: 0,
      input_recovered_completions: 0,
      input_gate_hits: 0,
    });
    expect(readVolley(h.sql)).toBeNull();
    expect(readEvents(room)).toEqual([]);
  });
});

describe('已提交批次与幸存者终局', () => {
  it('对手在批次未结时弃赛：完成只得到快照，不记录新施法；已提交批次到点恰好结算一次', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(70);
    await h.send('a', h.frame('a')); // 已提交的攻击在窗口里等待
    h.at(80);
    await manualLeave(h.scope, 'b'); // 对手在窗口内弃赛：批次未结，对局保持 playing
    expect(h.room()!.phase).toBe('playing');
    expect(readVolley(h.sql)!.casts).toHaveLength(1);

    h.at(90);
    await h.send('a', h.frame('a')); // 无存活对手的完成：批次还悬着，只回快照
    expect(h.player('a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1, // 不记录新完成
      draft_epoch: 0, // 不制造恢复
      input_recoveries: 0,
      input_gate_hits: 0,
      input_recovered_completions: 0,
    });
    expect(readVolley(h.sql)!.casts).toHaveLength(1); // 原有承诺不被追加或改写

    h.at(100);
    await advanceOnce(h.scope); // 批次到点：恰好结算一次并终局
    expect(readVolley(h.sql)).toBeNull();
    const room = h.room()!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('elimination');
    expect(room.ended_at).toBe(windowEnd(70));
    expect(readEvents(room)).toEqual([]); // 对手已弃赛：份额弃置，无事件
    expect(resultRows(h.sql, 'rank, spells_cast')).toEqual([
      { user_id: 'a', rank: 1, spells_cast: 1 },
      { user_id: 'b', rank: 2, spells_cast: 0 },
    ]);
  });
});

describe('结算 await 期间的替换竞态', () => {
  it('输入悬在结算中时座位被替换：旧连接不落任何效果，只有已提交的批次落地一次', async () => {
    const gate = Promise.withResolvers<void>();
    const storage = openTestStorage();
    open.push(storage);
    seedMatchRoom(storage, ['a', 'b'], {
      mode: 'observe',
      phase: 'playing',
      openedAt: T0,
      deadline: COMBAT_END,
    });
    const h = buildHarness(
      storage,
      ['a', 'b'],
      makeEnv('observe', async () => {
        await gate.promise;
        return {};
      }),
    );
    updatePlayer(h.sql, 'b', { hp: damageOf(BOOK[0].text) });

    h.at(70);
    await h.send('a', h.frame('a')); // 致命一击入队，窗口末落地
    h.at(100);
    const pending = h.send('a', h.frame('a')); // 下一发完成帧：先结清批次再裁决自己
    // 批次结清并把比赛送进终局，终局在 D1 写入处让出事件循环：
    // 就在这一步里，一条新连接接管了 a 的座位。
    h.takeover('a', 'a-conn2');
    gate.resolve();
    await pending;

    const room = h.room()!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('elimination');
    expect(room.ended_at).toBe(windowEnd(70)); // 按批次自己的时刻终局，不按迟到的续跑时刻
    // 只有悬停前已提交的那一发算数：替换后的旧帧什么都没有再落。
    expect(h.player('a')).toMatchObject({ spell_index: 1, spells_cast: 1, draft_epoch: 0 });
    const events = readEvents(room);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      attackerId: 'a',
      targetId: 'b',
      damage: damageOf(BOOK[0].text),
      eliminated: true,
      at: windowEnd(70),
    });
    expect(readVolley(h.sql)).toBeNull();
    expect(resultRows(h.sql, 'rank')).toEqual([
      { user_id: 'a', rank: 1 },
      { user_id: 'b', rank: 2 },
    ]);
    // 新连接读到的是终局权威状态；旧连接只会被替换路径收尾。
    expect(h.snapshot('a').phase).toBe('finished');
    expect(h.sockets.a.closes).toContainEqual({
      code: WS_CLOSE.replaced,
      reason: 'not the current connection',
    });
  });
});

describe('恢复指标', () => {
  it('恢复后未完成即离场计入 recovery_departures；完成后再离场不计', async () => {
    // 场景一：恢复过的当前咒文仍未完成，主动离场 —— 计一次。
    const left = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await left.send('b', left.frame('b')); // b 过早完成：恢复代际 1
    expect(left.player('b').draft_epoch).toBe(1);
    left.at(10);
    await manualLeave(left.scope, 'b');
    expect(resultRows(left.sql, 'input_recovery_departures, input_recovered_completions')).toEqual([
      { user_id: 'a', input_recovery_departures: 0, input_recovered_completions: 0 },
      { user_id: 'b', input_recovery_departures: 1, input_recovered_completions: 0 },
    ]);

    // 场景二：恢复后先把当前咒文补全（代际归零），再离场 —— 不计离场。
    const done = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    await done.send('b', done.frame('b')); // 过早：代际 1
    done.at(70);
    await done.send('b', done.frame('b')); // 就绪补全：代际归零、恢复完成计一次
    expect(done.player('b')).toMatchObject({
      draft_epoch: 0,
      input_recovered_completions: 1,
    });
    done.at(80);
    await manualLeave(done.scope, 'b');
    done.at(100);
    await advanceOnce(done.scope);
    expect(resultRows(done.sql, 'input_recovery_departures, input_recovered_completions')).toEqual([
      { user_id: 'a', input_recovery_departures: 0, input_recovered_completions: 0 },
      { user_id: 'b', input_recovery_departures: 0, input_recovered_completions: 1 },
    ]);
  });
});

describe('SQL 异常回滚', () => {
  it('开局事务中途失败：座位复位与策略锁定整体回滚，重跑成功', () => {
    const lobby = lobbyHarness(['a', 'b'], makeEnv('enforce'));
    updatePlayer(lobby.sql, 'a', { hp: 7, input_gate_hits: 5, spells_cast: 3 });

    const restore = failSqlOn(lobby.scope, /UPDATE room SET/);
    expect(() => startMatch(lobby.scope, getRoom(lobby.sql)!)).toThrow('injected sql failure');
    restore();

    expect(getRoom(lobby.sql)!).toMatchObject({
      phase: 'lobby',
      match_id: null,
      generation_token: null,
      error: null,
      input_policy_version: null,
    });
    expect(getPlayer(lobby.sql, 'a')).toMatchObject({ hp: 7, input_gate_hits: 5, spells_cast: 3 });

    expect(startMatch(lobby.scope, getRoom(lobby.sql)!)).toBe(true);
    expect(getRoom(lobby.sql)!).toMatchObject({
      phase: 'generating',
      input_policy_version: INPUT_POLICY_VERSION,
      input_policy_mode: 'enforce',
      input_min_ms_per_code_point: INPUT_MIN_MS_PER_CODE_POINT,
    });
    expect(getPlayer(lobby.sql, 'a')).toMatchObject({
      hp: INITIAL_HEALTH,
      input_gate_hits: 0,
      spells_cast: 0,
      draft_epoch: 0,
      input_opened_at: null,
    });
  });

  it('倒计时转换中途失败：资格写入与 playing 转换整体回滚，重跑按同一时刻就绪', async () => {
    const h = countdownHarness(['a', 'b'], makeEnv('enforce'));
    h.at(3_000);
    const restore = failSqlOn(h.scope, /UPDATE room SET/);
    await expect(advanceOnce(h.scope)).rejects.toThrow('injected sql failure');
    restore();

    expect(h.room()).toMatchObject({
      phase: 'countdown',
      started_at: null,
      deadline: T0 + 3_000,
    });
    for (const userId of ['a', 'b']) {
      expect(h.player(userId)).toMatchObject({
        input_opened_at: null,
        input_not_before: null,
        draft_epoch: 0,
      });
    }

    expect(await advanceOnce(h.scope)).toBe(true);
    expect(h.room()).toMatchObject({
      phase: 'playing',
      started_at: T0 + 3_000,
      deadline: T0 + 3_000 + MATCH_DURATION_MS,
    });
    expect(h.player('a')).toMatchObject({
      input_opened_at: T0 + 3_000,
      input_not_before: T0 + 3_000 + floorOf(BOOK[0].text),
    });
  });

  it('接受完成中途失败：施法承诺与游标推进整体回滚，重发恰好接受一次', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    h.at(70);
    const restore = failSqlOn(h.scope, /UPDATE players SET/);
    await expect(h.send('a', h.frame('a'))).rejects.toThrow('injected sql failure');
    restore();

    expect(readVolley(h.sql)).toBeNull(); // 批次写入被回滚
    expect(h.player('a')).toMatchObject({
      spell_index: 0,
      spells_cast: 0,
      correct_chars: 0,
      attempt_total: 0,
      input_opened_at: T0,
      input_not_before: T0 + floorOf(BOOK[0].text),
      draft_epoch: 0,
    });
    expect(h.player('b').hp).toBe(INITIAL_HEALTH);

    await h.send('a', h.frame('a'));
    expect(h.player('a')).toMatchObject({ spell_index: 1, spells_cast: 1 });
    expect(readVolley(h.sql)!.casts).toHaveLength(1);
  });

  it('结算中途失败：伤害批次独立落地保持不变，名次与阶段回滚，重跑按原截止收尾', async () => {
    const h = playingHarness(['a', 'b'], { mode: 'enforce', openedAt: T0 });
    updatePlayer(h.sql, 'a', { cpm: 7 }); // 哨兵：结算会重写 cpm，回滚必须还原它
    updatePlayer(h.sql, 'b', { hp: damageOf(BOOK[0].text) });
    h.at(70);
    await h.send('a', h.frame('a'));
    h.at(100);

    const restore = failSqlOn(h.scope, /INSERT INTO match_results/);
    await expect(advanceOnce(h.scope)).rejects.toThrow('injected sql failure');
    restore();

    // 伤害批次是自己的事务，早已提交：不随结算失败回退，也不重放。
    expect(h.player('b')).toMatchObject({ hp: 0, eliminated_at: windowEnd(70) });
    expect(readEvents(h.room()!)).toHaveLength(1);
    expect(readVolley(h.sql)).toBeNull();
    // 结算块整体回滚：阶段、终局时刻、名次与 cpm 重写一并还原。
    expect(h.room()).toMatchObject({ phase: 'playing', ended_at: null, end_reason: null });
    expect(
      h.sql.exec<{ total: number }>('SELECT COUNT(*) AS total FROM match_results').one(),
    ).toEqual({ total: 0 });
    expect(h.player('a').cpm).toBe(7);

    // 重跑在比赛截止处按幸存者规则完整收尾。
    h.at(MATCH_DURATION_MS);
    expect(await advanceOnce(h.scope)).toBe(true);
    const room = h.room()!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('elimination');
    expect(room.ended_at).toBe(COMBAT_END);
    expect(resultRows(h.sql, 'rank, cpm')).toEqual([
      { user_id: 'a', rank: 1, cpm: 1 },
      { user_id: 'b', rank: 2, cpm: 0 },
    ]);
  });
});
