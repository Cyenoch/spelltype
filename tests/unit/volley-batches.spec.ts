/**
 * 同窗批量结算 — combat damage lands per fixed 100ms window, not per keystroke.
 *
 * What a plausible bug would silently break, driven through the room's own public entry points
 * (`handleInput`, `advanceOnce`, `snapshotFor`) against the real SQLite state layer, with the clock
 * under test control: the cursor advances at once while health waits for the window end; a window's
 * total spell power splits exactly (integer sixth-HP units) across every other living player no
 * matter where they sit; a simultaneous mutual lethal shares first place; a due batch applies
 * before any later window's cast is queued; pre-deadline casts settle before the timeout; a restart
 * against the same durable state neither loses nor duplicates a batch; and a manual departure
 * neither drops a committed cast nor redirects its share.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_HEALTH, MATCH_DURATION_MS, WS_PROTOCOL, type Spell } from '../../shared/protocol';
import type { Env } from '../../worker/env';
import { handleInput } from '../../worker/rooms/combat';
import { INPUT_MIN_MS_PER_CODE_POINT, INPUT_POLICY_VERSION } from '../../worker/rooms/rules';
import { InputBudget, type RoomScope } from '../../worker/rooms/scope';
import { snapshotFor } from '../../worker/rooms/snapshots';
import { manualLeave } from '../../worker/rooms/leave';
import { readEvents } from '../../worker/rooms/storage/events';
import { getPlayer, insertPlayer, updatePlayer } from '../../worker/rooms/storage/players';
import { getRoom, insertRoom, updateRoom } from '../../worker/rooms/storage/room';
import { createSchema } from '../../worker/rooms/storage/schema';
import type { SqlStore } from '../../worker/sql';
import { advanceOnce } from '../../worker/rooms/transitions';
import { openFileTestStorage, openTestStorage, type TestStorage } from '../support/sql-storage';
import { spellAt } from '../../worker/scoring';
import { readSpellBook } from '../../worker/rooms/storage/spell-book';

const T0 = 1_700_000_000_000;
const ROOM_ID = 'c'.repeat(24);
const MATCH_ID = 'match-volley';
const COMBAT_END = T0 + MATCH_DURATION_MS;
/**
 * Four spells: two four-code-point casts (16 power each) drive most scenarios; the twelve- and
 * eight-code-point spells (48 and 32 power) let one test give two survivors equal health from
 * unequal casting across windows with different split denominators.
 */
const BOOK: Spell[] = [
  { name: '焰咒', text: '咒文对决', translation: '焰', element: 'fire' },
  { name: '霜咒', text: '霜月幽炎', translation: '霜', element: 'ice' },
  { name: '日咒', text: '烈日焚空裂地焚海燃城灭世', translation: '日', element: 'fire' },
  { name: '冰咒', text: '冰封千里朔风卷雪', translation: '冰', element: 'ice' },
];
const TOTAL_POWER = 4 * BOOK[0].text.length;
/** Sixth-HP units: LCM(1,2,3) makes every 2–4 player split an exact integer. */
const SCALE = 6;
const FULL = INITIAL_HEALTH * SCALE;

type StubSocket = WebSocket & { readyState: number };

interface Harness {
  storage: TestStorage;
  scope: RoomScope;
  sql: SqlStore;
  sockets: Record<string, StubSocket>;
  /** Casts the player's current spell at the current instant. */
  cast(userId: string, spellIndex: number): Promise<void>;
  /** Moves the room clock to `T0 + offsetMs`. */
  at(offsetMs: number): void;
}

let open: TestStorage[] = [];

function meta(userId: string) {
  return {
    userId,
    username: userId,
    connId: `${userId}-conn`,
    sessionHash: `${userId}-session`,
    sessionExpires: T0 + 3_600_000,
    protocolVersion: WS_PROTOCOL,
  };
}

/** Seeds one fresh playing match with the given seats; a fresh database only, never a reopen. */
function seedMatchState(storage: TestStorage, userIds: readonly string[]): void {
  createSchema(storage.sql);
  insertRoom(storage.sql, {
    id: ROOM_ID,
    hostId: userIds[0],
    mode: 'private',
    theme: '同窗契约',
    difficulty: 'hard',
    reservationState: 'none',
    reservationExpiresAt: null,
    now: T0,
  });
  updateRoom(storage.sql, {
    phase: 'playing',
    locked: 1,
    match_id: MATCH_ID,
    started_at: T0,
    deadline: COMBAT_END,
    spell_book: JSON.stringify(BOOK),
    // 观察模式：伤害批次的判定不与施法时间门槛耦合（门槛自身另有测试）。
    input_policy_version: INPUT_POLICY_VERSION,
    input_policy_mode: 'observe',
    input_min_ms_per_code_point: INPUT_MIN_MS_PER_CODE_POINT,
  });
  for (const userId of userIds) {
    insertPlayer(storage.sql, { userId, username: userId, slotExpiresAt: null, now: T0 });
    updatePlayer(storage.sql, userId, {
      seated: 1,
      conn_id: `${userId}-conn`,
      input_opened_at: T0,
      input_not_before: T0 + BOOK[0].text.length * INPUT_MIN_MS_PER_CODE_POINT,
    });
  }
}

/** Wires stub sockets and one room scope over whatever durable state the storage already holds. */
function combatHarness(storage: TestStorage, userIds: readonly string[]): Harness {
  const sockets: Record<string, StubSocket> = {};
  for (const userId of userIds) {
    const ws = {
      readyState: WebSocket.OPEN as number,
      deserializeAttachment: () => meta(userId),
      send: () => {},
      close: () => {
        ws.readyState = WebSocket.CLOSED;
      },
    };
    sockets[userId] = ws as unknown as StubSocket;
  }
  const scope: RoomScope = {
    sql: storage.sql,
    env: {
      MATCH_ADMISSION: 'open',
      DB: { prepare: () => ({ bind: () => ({}) }), batch: async () => ({}) },
    } as unknown as Env,
    input: new InputBudget(),
    alarm: { set: async () => {}, clear: async () => {} },
    sockets: () => Object.values(sockets),
    transactionSync: storage.transactionSync,
  };
  return {
    storage,
    scope,
    sql: storage.sql,
    sockets,
    cast: async (userId, spellIndex) => {
      const self = getPlayer(storage.sql, userId)!;
      await handleInput(scope, sockets[userId], meta(userId), {
        type: 'input',
        matchId: MATCH_ID,
        spellIndex,
        draftEpoch: self.draft_epoch,
        text: spellAt(readSpellBook(getRoom(storage.sql)!), spellIndex)!.text,
      });
    },
    at: (offsetMs) => vi.setSystemTime(T0 + offsetMs),
  };
}

function startCombat(userIds: readonly string[]): Harness {
  vi.setSystemTime(T0);
  const storage = openTestStorage();
  open.push(storage);
  seedMatchState(storage, userIds);
  return combatHarness(storage, userIds);
}

function hpOf(h: Harness, userId: string): number {
  return getPlayer(h.sql, userId)!.hp;
}

/** HP as integer sixth-units, the only exact currency a fractional health read can be pinned in. */
function sixths(hp: number): number {
  return Math.round(hp * SCALE);
}

function eventsOf(h: Harness) {
  return readEvents(getRoom(h.sql)!);
}

function resultRows(
  sql: SqlStore,
): { user_id: string; rank: number; hp_remaining: number; spells_cast: number }[] {
  return sql
    .exec<{
      user_id: string;
      rank: number;
      hp_remaining: number;
      spells_cast: number;
    }>('SELECT user_id, rank, hp_remaining, spells_cast FROM match_results ORDER BY user_id')
    .toArray();
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  vi.useRealTimers();
  for (const storage of open.splice(0)) storage.close();
});

describe('窗口与游标', () => {
  it('提交当刻推进法术游标，伤害与事件等到窗口末才一次性落地', async () => {
    const h = startCombat(['a', 'b', 'c']);
    await h.cast('a', 0);

    expect(getPlayer(h.sql, 'a')).toMatchObject({ spell_index: 1, spells_cast: 1 });
    for (const id of ['a', 'b', 'c']) expect(hpOf(h, id)).toBe(INITIAL_HEALTH);
    expect(eventsOf(h)).toEqual([]);

    h.at(50);
    await advanceOnce(h.scope);
    for (const id of ['a', 'b', 'c']) expect(hpOf(h, id)).toBe(INITIAL_HEALTH);
    expect(eventsOf(h)).toEqual([]);

    h.at(100);
    await advanceOnce(h.scope);
    // 一发总伤 16，三人局均摊给另两人：每人恰好 8。
    expect(sixths(hpOf(h, 'b'))).toBe(FULL - 48);
    expect(sixths(hpOf(h, 'c'))).toBe(FULL - 48);
    expect(hpOf(h, 'a')).toBe(INITIAL_HEALTH);
  });
});

describe('固定总伤均分', () => {
  it('三人局对半、四人局三等分，全部落在整数六分之一血格上', async () => {
    const three = startCombat(['a', 'b', 'c']);
    await three.cast('a', 0);
    three.at(100);
    await advanceOnce(three.scope);

    const events = eventsOf(three).sort((x, y) => x.targetId.localeCompare(y.targetId));
    expect(events.map((event) => [event.attackerId, event.targetId])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
    ]);
    for (const event of events) {
      expect(event).toMatchObject({
        at: T0 + 100,
        damage: 8,
        targetHp: INITIAL_HEALTH - 8,
        element: 'fire',
        spellIndex: 0,
        eliminated: false,
      });
    }
    expect(events.map((event) => event.seq).sort((x, y) => x - y)).toEqual([1, 2]);
    expect(events.reduce((sum, event) => sum + event.damage, 0)).toBeCloseTo(TOTAL_POWER, 6);

    const four = startCombat(['a', 'b', 'c', 'd']);
    await four.cast('a', 0);
    four.at(100);
    await advanceOnce(four.scope);

    for (const id of ['b', 'c', 'd']) expect(sixths(hpOf(four, id))).toBe(FULL - 32);
    expect(hpOf(four, 'a')).toBe(INITIAL_HEALTH);
    expect(eventsOf(four).reduce((sum, event) => sum + event.damage, 0)).toBeCloseTo(
      TOTAL_POWER,
      6,
    );
  });

  it('伤害不偏置座位：任一座位施法，其余存活者都均摊同额', async () => {
    // 施法者在末位：老规则只会打顺时针下家，新规则打其余全部。
    const fromLast = startCombat(['a', 'b', 'c', 'd']);
    await fromLast.cast('d', 0);
    fromLast.at(100);
    await advanceOnce(fromLast.scope);
    for (const id of ['a', 'b', 'c']) expect(sixths(hpOf(fromLast, id))).toBe(FULL - 32);

    // 同一批人换成施法者坐首位，结果逐座位相同：座位排列不影响分摊。
    const fromFirst = startCombat(['d', 'a', 'b', 'c']);
    await fromFirst.cast('d', 0);
    fromFirst.at(100);
    await advanceOnce(fromFirst.scope);
    for (const id of ['a', 'b', 'c']) expect(sixths(hpOf(fromFirst, id))).toBe(FULL - 32);
  });

  it('三分之一血长程重复不漂移：每一步都落在整数六分之一血格上', async () => {
    const h = startCombat(['a', 'b', 'c', 'd']);
    updateRoom(h.sql, { spell_book: JSON.stringify(BOOK.slice(0, 2)) });
    // b 只剩 100（600 六分之一格）：第 19 发命中时越界致死，此后人数收缩改变分母。
    updatePlayer(h.sql, 'b', { hp: 100 });
    for (let step = 1; step <= 40; step += 1) {
      h.at((step - 1) * 100);
      await h.cast('a', step - 1);
      h.at(step * 100);
      await advanceOnce(h.scope);

      expect(sixths(hpOf(h, 'b'))).toBe(Math.max(0, 600 - 32 * step));
      const expected = FULL - 32 * Math.min(step, 19) - 48 * Math.max(0, step - 19);
      expect(sixths(hpOf(h, 'c'))).toBe(expected);
      expect(sixths(hpOf(h, 'd'))).toBe(expected);
      if (step === 19) {
        expect(
          eventsOf(h).filter((event) => event.targetId === 'b' && event.eliminated),
        ).toHaveLength(1);
      }
    }
    expect(getPlayer(h.sql, 'b')!.eliminated_at).toBe(T0 + 1_900);
    expect(getPlayer(h.sql, 'a')).toMatchObject({ spell_index: 40, spells_cast: 40 });
  });
});

describe('同窗致死与结算', () => {
  it('同窗互致致命：双方提交都被接受，同批同时归零并共享第一', async () => {
    const h = startCombat(['a', 'b']);
    updatePlayer(h.sql, 'a', { hp: 10 });
    updatePlayer(h.sql, 'b', { hp: 10 });

    await h.cast('a', 0);
    await h.cast('b', 0);
    // 双方都在同一窗口提交并被接受，伤害仍未生效。
    expect(getPlayer(h.sql, 'a')).toMatchObject({ spell_index: 1, spells_cast: 1 });
    expect(getPlayer(h.sql, 'b')).toMatchObject({ spell_index: 1, spells_cast: 1 });
    expect(hpOf(h, 'a')).toBe(10);
    expect(hpOf(h, 'b')).toBe(10);

    h.at(100);
    await advanceOnce(h.scope);

    const room = getRoom(h.sql)!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('elimination');
    expect(room.ended_at).toBe(T0 + 100);
    expect(hpOf(h, 'a')).toBe(0);
    expect(hpOf(h, 'b')).toBe(0);
    expect(getPlayer(h.sql, 'a')!.eliminated_at).toBe(T0 + 100);
    expect(getPlayer(h.sql, 'b')!.eliminated_at).toBe(T0 + 100);

    const events = eventsOf(h);
    expect(events).toHaveLength(2);
    expect(
      events
        .filter((event) => event.eliminated)
        .map((event) => event.targetId)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(events.every((event) => event.at === T0 + 100 && event.targetHp === 0)).toBe(true);
    // 越界按比例入账：两边合计正好是窗前存在的血量。
    expect(events.reduce((sum, event) => sum + event.damage, 0)).toBeCloseTo(20, 6);

    const snapshot = snapshotFor(h.scope, { id: 'a', username: 'a' });
    expect(
      snapshot.players
        .toSorted((a, b) => a.id.localeCompare(b.id))
        .map((player) => [player.id, player.rank]),
    ).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
    expect(
      resultRows(h.sql)
        .sort((a, b) => a.user_id.localeCompare(b.user_id))
        .map((row) => [row.user_id, row.rank]),
    ).toEqual([
      ['a', 1],
      ['b', 1],
    ]);

    // 终局之后的下一次攻击被整体拒绝：游标、计数与事件都不再移动。
    const eventsBefore = eventsOf(h);
    await h.cast('a', 1);
    expect(getPlayer(h.sql, 'a')).toMatchObject({ spell_index: 1, spells_cast: 1 });
    expect(eventsOf(h)).toEqual(eventsBefore);
    expect(getRoom(h.sql)!.phase).toBe('finished');
  });

  it('上一窗到点先于下一窗输入结算：先落地的伤害与后入队的施法互不污染', async () => {
    const h = startCombat(['a', 'b', 'c']);
    updatePlayer(h.sql, 'b', { hp: 8 }); // 一发对半，恰好致死 b
    await h.cast('a', 0);

    h.at(100);
    // 下一窗的施法先到：handleInput 必须先把到期的批次结清，再接受这次施法。
    await h.cast('c', 0);

    expect(getPlayer(h.sql, 'b')!.eliminated_at).toBe(T0 + 100);
    expect(hpOf(h, 'c')).toBe(INITIAL_HEALTH - 8);
    expect(eventsOf(h).map((event) => [event.attackerId, event.at])).toEqual([
      ['a', T0 + 100],
      ['a', T0 + 100],
    ]);

    // c 的施法在已结清的新窗口里等待，到点后作为独立一批落地。
    h.at(200);
    await advanceOnce(h.scope);
    const events = eventsOf(h);
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({
      seq: events[1].seq + 1,
      at: T0 + 200,
      attackerId: 'c',
      targetId: 'a',
      spellIndex: 0,
    });
    // a 在第一批里是施法者（自身免疫），只在第二批挨 c 的全额一击。
    expect(hpOf(h, 'a')).toBe(INITIAL_HEALTH - 16);
    expect(getRoom(h.sql)!.phase).toBe('playing');
  });

  it('截限前最后一窗先结算再按超时收尾；截限后的输入不再接受', async () => {
    const h = startCombat(['a', 'b']);
    h.at(MATCH_DURATION_MS - 50); // 窗口末被截限封顶：批次恰好在截限时刻到期
    await h.cast('a', 0);

    h.at(MATCH_DURATION_MS);
    await advanceOnce(h.scope);

    const room = getRoom(h.sql)!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('timeout');
    expect(room.ended_at).toBe(COMBAT_END);
    expect(hpOf(h, 'b')).toBe(INITIAL_HEALTH - TOTAL_POWER);
    const events = eventsOf(h);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      at: COMBAT_END,
      attackerId: 'a',
      targetId: 'b',
      damage: TOTAL_POWER,
      targetHp: INITIAL_HEALTH - TOTAL_POWER,
      eliminated: false,
    });

    await h.cast('b', 0);
    expect(getPlayer(h.sql, 'b')).toMatchObject({ spell_index: 0, spells_cast: 0 });
    expect(eventsOf(h)).toEqual(events);
  });

  it('截限当刻到期的致死批次按淘汰收尾，而不是超时', async () => {
    const h = startCombat(['a', 'b']);
    updatePlayer(h.sql, 'b', { hp: TOTAL_POWER });
    h.at(MATCH_DURATION_MS - 50);
    await h.cast('a', 0);

    h.at(MATCH_DURATION_MS);
    await advanceOnce(h.scope);

    const room = getRoom(h.sql)!;
    expect(room).toMatchObject({
      phase: 'finished',
      end_reason: 'elimination',
      ended_at: COMBAT_END,
    });
    expect(hpOf(h, 'b')).toBe(0);
    expect(getPlayer(h.sql, 'b')!.eliminated_at).toBe(COMBAT_END);
    const snapshot = snapshotFor(h.scope, { id: 'a', username: 'a' });
    expect(
      snapshot.players
        .toSorted((a, b) => a.id.localeCompare(b.id))
        .map((player) => [player.id, player.rank]),
    ).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('结局快照：血量相同即并列，产出差异不打破生存并列', async () => {
    const h = startCombat(['a', 'b', 'c', 'd']);
    updatePlayer(h.sql, 'a', {
      spell_index: 2,
      input_not_before: T0 + BOOK[2].text.length * INPUT_MIN_MS_PER_CODE_POINT,
    });
    // 第一窗（四人分母 3）：a 施放十二字大咒，b、c、d 各挨 16，a 全额入账 48。
    await h.cast('a', 2);
    h.at(100);
    await advanceOnce(h.scope);
    expect(sixths(hpOf(h, 'b'))).toBe(FULL - 96);

    // 恰在窗口边界弃赛：d 的名字从此不在名册里，第二窗缩成三人分母。
    await manualLeave(h.scope, 'd');
    expect(hpOf(h, 'd')).toBe(0);
    expect(getPlayer(h.sql, 'd')!.eliminated_at).toBe(T0 + 100);

    // 第二、三窗（三人分母 2）：b 连施两记四字咒，a、c 各挨两笔 8。
    await h.cast('b', 0);
    h.at(200);
    await advanceOnce(h.scope);
    await h.cast('b', 1);
    h.at(300);
    await advanceOnce(h.scope);

    // a 与 b 同为 2384，但 a 输出 48、b 只输出 32：名次并列第一，产出不是名次的输入。
    h.at(MATCH_DURATION_MS);
    await advanceOnce(h.scope);
    const snapshot = snapshotFor(h.scope, { id: 'a', username: 'a' });
    expect(snapshot.endReason).toBe('timeout');
    const byId = new Map(snapshot.players.map((player) => [player.id, player]));
    expect(byId.get('a')!.rank).toBe(1);
    expect(byId.get('b')!.rank).toBe(1);
    expect(byId.get('c')!.rank).toBe(3);
    expect(byId.get('d')!.rank).toBe(4);
    expect(byId.get('a')!.hp).toBeCloseTo(INITIAL_HEALTH - 16, 6);
    expect(byId.get('b')!.hp).toBeCloseTo(INITIAL_HEALTH - 16, 6);
    expect(byId.get('c')!.hp).toBeCloseTo(INITIAL_HEALTH - 32, 6);
    expect(byId.get('a')!.damageDealt).toBe(48);
    expect(byId.get('b')!.damageDealt).toBe(32);
    expect(byId.get('c')!.damageDealt).toBe(0);
    expect(byId.get('d')!.hp).toBe(0);
  });
});

describe('持久与离场', () => {
  it('对同一份持久 SQLite 重开实例：待结算批次不丢、不重', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spelltype-volley-restart-'));
    let reopened: TestStorage | null = null;
    try {
      const dbPath = join(dir, 'room.sqlite');
      const first = openFileTestStorage(dbPath);
      seedMatchState(first, ['a', 'b']);
      const firstRun = combatHarness(first, ['a', 'b']);
      await firstRun.cast('a', 0);
      // 待结算批次是持久状态：整个实例连同连接一起关闭。
      first.close();

      // 新实例对同一文件重跑幂等建表，只挂新连接与新 scope。
      reopened = openFileTestStorage(dbPath);
      createSchema(reopened.sql);
      const second = combatHarness(reopened, ['a', 'b']);
      const room = getRoom(second.sql)!;
      expect(room).toMatchObject({ phase: 'playing', match_id: MATCH_ID, started_at: T0 });
      expect(getPlayer(second.sql, 'a')).toMatchObject({ spell_index: 1, spells_cast: 1 });
      expect(hpOf(second, 'b')).toBe(INITIAL_HEALTH);

      second.at(100);
      await advanceOnce(second.scope);
      expect(hpOf(second, 'b')).toBe(INITIAL_HEALTH - TOTAL_POWER);
      expect(eventsOf(second)).toHaveLength(1);

      // 再走一遍不会再落一次：批次恰好结算一次。
      await advanceOnce(second.scope);
      expect(hpOf(second, 'b')).toBe(INITIAL_HEALTH - TOTAL_POWER);
      expect(eventsOf(second)).toHaveLength(1);
    } finally {
      reopened?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('窗口内弃赛：已提交的施法保留承诺，其分摊被弃置而不转嫁', async () => {
    const h = startCombat(['a', 'b', 'c']);
    await h.cast('a', 0); // 名册在窗口首个施法时冻结为 [a, b, c]
    h.at(40);
    await manualLeave(h.scope, 'b');
    expect(hpOf(h, 'b')).toBe(0);
    expect(getPlayer(h.sql, 'b')!.eliminated_at).toBe(T0 + 40);
    expect(getRoom(h.sql)!.phase).toBe('playing');

    h.at(100);
    await advanceOnce(h.scope);
    // b 的份额被弃置而非转嫁：c 只收到一半（8），没有人替 b 挨满 16。
    expect(sixths(hpOf(h, 'c'))).toBe(FULL - 48);
    expect(hpOf(h, 'a')).toBe(INITIAL_HEALTH);
    expect(hpOf(h, 'b')).toBe(0);
    const events = eventsOf(h);
    expect(events.map((event) => [event.attackerId, event.targetId])).toEqual([['a', 'c']]);
    expect(events[0]).toMatchObject({ damage: 8, targetHp: INITIAL_HEALTH - 8, eliminated: false });
    expect(getPlayer(h.sql, 'a')!.damage_dealt).toBeCloseTo(8, 6);
    expect(getPlayer(h.sql, 'b')!.damage_dealt).toBe(0);
  });

  it('双人局最后对手弃赛：结算等已提交批次落地后再收尾', async () => {
    const h = startCombat(['a', 'b']);
    await h.cast('a', 0);
    h.at(40);
    await manualLeave(h.scope, 'b');
    expect(getPlayer(h.sql, 'b')!.eliminated_at).toBe(T0 + 40);
    // 还有未结算批次：房间等待批次落地，而不是在批次之下收尾。
    expect(getRoom(h.sql)!.phase).toBe('playing');

    h.at(100);
    await advanceOnce(h.scope);
    const room = getRoom(h.sql)!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('elimination');
    // 弃赛不回滚已接受的施法：游标与计数保持推进；没有任何伤害转嫁到施法者自己身上。
    expect(getPlayer(h.sql, 'a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
      hp: INITIAL_HEALTH,
      damage_dealt: 0,
    });
    // b 已弃赛：批次没有任何可命中对象，事件为空也不算丢失。
    expect(eventsOf(h)).toEqual([]);
    const rows = resultRows(h.sql);
    expect(
      rows
        .toSorted((a, b) => a.user_id.localeCompare(b.user_id))
        .map((row) => [row.user_id, row.rank, row.spells_cast]),
    ).toEqual([
      ['a', 1, 1],
      ['b', 2, 0],
    ]);
    expect(rows.find((row) => row.user_id === 'b')!.hp_remaining).toBe(0);
  });
});
