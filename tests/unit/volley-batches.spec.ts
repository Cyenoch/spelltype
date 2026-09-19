/**
 * 同窗批量结算 —— 战斗伤害按固定的 100ms 窗口落地，而不是按每次按键落地。
 *
 * 每次被接受的施法都会加入房间唯一的持久化齐射排期行（`combat_volleys` 行）；
 * `advanceOnce` 在共享的窗口边界应用整个批次，进行基于 HEALTH_SCALE 精度无损的伤害均摊、
 * 按比例过量击杀奖励以及共享的幸存者排名计算。
 * 持久化的施法意图在运行时重启后依然存活，窗口中途离场会放弃其分摊份额而不会错误重定向。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';
import { INITIAL_HEALTH, MATCH_DURATION_MS, WS_PROTOCOL, type Spell } from '../../shared/protocol';
import type { RoomSocket } from '../../server/contracts';
import type { Database, OpenedDatabase } from '../../server/db';
import { openDatabase } from '../../server/db';
import { results } from '../../server/db/schema';
import { handleInput } from '../../server/rooms/combat';
import { INPUT_MIN_MS_PER_CODE_POINT, INPUT_POLICY_VERSION } from '../../server/rooms/rules';
import { createRoomScope, InputBudget, SocketRegistry } from '../../server/rooms/scope';
import type { RoomScope, SocketAuth } from '../../server/rooms/scope';
import { snapshotFor } from '../../server/rooms/snapshots';
import { manualLeave } from '../../server/rooms/leave';
import { readEvents } from '../../server/rooms/storage/events';
import { getPlayer, insertPlayer, updatePlayer } from '../../server/rooms/storage/players';
import { createRoom, getRoom, updateRoom } from '../../server/rooms/storage/room';
import { readSpellBook } from '../../server/rooms/storage/spell-book';
import { advanceOnce } from '../../server/rooms/transitions';
import { spellAt } from '../../server/scoring';

// PGlite 保持原生定时器截止时间；确定性时间偏移不需要历史纪元。
const T0 = Date.now();
const ROOM_ID = 'c'.repeat(24);
const MATCH_ID = 'match-volley';
const COMBAT_END = T0 + MATCH_DURATION_MS;
/**
 * 四条咒文：两条 4 码点咒文（各 16 威力）驱动大部分场景；
 * 12 码点和 8 码点咒文（48 和 32 威力）用于测试两名幸存者在不同分母的不同窗口中因非均等施法而产生相同剩余血量。
 */
const BOOK: Spell[] = [
  { name: '焰咒', text: '咒文对决', translation: '焰', element: 'fire' },
  { name: '霜咒', text: '霜月幽炎', translation: '霜', element: 'ice' },
  { name: '日咒', text: '烈日焚空裂地焚海燃城灭世', translation: '日', element: 'fire' },
  { name: '冰咒', text: '冰封千里朔风卷雪', translation: '冰', element: 'ice' },
];
const TOTAL_POWER = 4 * BOOK[0].text.length;
/** 六分之一 HP 单位：LCM(1,2,3) 使得 2–4 名玩家的每一次伤害均摊都是精确整数。 */
const SCALE = 6;
const FULL = INITIAL_HEALTH * SCALE;

interface StubSocket {
  socket: RoomSocket;
}

interface Harness {
  db: Database;
  scope: RoomScope;
  registry: SocketRegistry;
  sockets: Record<string, StubSocket>;
  /** 在当前时刻施放该玩家的当前咒文。 */
  cast(userId: string, spellIndex: number): Promise<void>;
  /** 将房间时钟推进到 `T0 + offsetMs`。 */
  at(offsetMs: number): void;
}

const databases: OpenedDatabase[] = [];
let now = T0;

function meta(userId: string): SocketAuth {
  return {
    userId,
    username: userId,
    connId: `${userId}-conn`,
    sessionHash: `${userId}-session`,
    sessionExpires: T0 + 3_600_000,
    protocolVersion: WS_PROTOCOL,
  };
}

async function openTestDb(dir?: string): Promise<OpenedDatabase> {
  const opened = await openDatabase(dir === undefined ? 'pglite://:memory:' : `pglite://${dir}`);
  databases.push(opened);
  return opened;
}

/** 使用给定席位初始化一场新鲜的进行中对局；仅用于全新数据库，绝不用于重开。 */
async function seedMatchState(db: Database, userIds: readonly string[]): Promise<void> {
  await createRoom(db, {
    id: ROOM_ID,
    host: { id: userIds[0], username: userIds[0] },
    theme: '同窗契约',
    mode: 'private',
  });
  await updateRoom(db, ROOM_ID, {
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
    await insertPlayer(db, ROOM_ID, { userId, username: userId, slotExpiresAt: null, now: T0 });
    await updatePlayer(db, ROOM_ID, userId, {
      seated: 1,
      conn_id: `${userId}-conn`,
      input_opened_at: T0,
      input_not_before: T0 + BOOK[0].text.length * INPUT_MIN_MS_PER_CODE_POINT,
    });
  }
}

/** 围绕数据库已持有的持久状态装配桩 socket 和房间作用域。 */
function combatHarness(db: Database, userIds: readonly string[]): Harness {
  const sockets: Record<string, StubSocket> = {};
  const registry = new SocketRegistry();
  for (const userId of userIds) {
    const state: StubSocket = { socket: null as unknown as RoomSocket };
    let readyState = 1;
    state.socket = {
      get readyState() {
        return readyState;
      },
      data: { roomId: ROOM_ID, protocolVersion: WS_PROTOCOL, session: null },
      send: () => {},
      close: () => {
        readyState = 3;
      },
    } as unknown as RoomSocket;
    sockets[userId] = state;
    registry.attach(state.socket, meta(userId));
  }
  const scope = createRoomScope({
    roomId: ROOM_ID,
    db,
    generate: async () => {
      throw new Error('generation not expected in volley tests');
    },
    registry,
    inputPolicyMode: 'observe',
    input: new InputBudget(),
    arm: async () => {},
  });
  return {
    db,
    scope,
    registry,
    sockets,
    cast: async (userId, spellIndex) => {
      const self = (await getPlayer(db, ROOM_ID, userId))!;
      await handleInput(scope, sockets[userId].socket, meta(userId), {
        type: 'input',
        matchId: MATCH_ID,
        spellIndex,
        draftEpoch: self.draft_epoch,
        text: spellAt(readSpellBook((await getRoom(db, ROOM_ID))!), spellIndex)!.text,
      });
    },
    at: (offsetMs) => {
      now = T0 + offsetMs;
      setSystemTime(now);
    },
  };
}

async function startCombat(userIds: readonly string[]): Promise<Harness> {
  now = T0;
  setSystemTime(now);
  const db = (await openTestDb()).db;
  await seedMatchState(db, userIds);
  return combatHarness(db, userIds);
}

async function hpOf(h: Harness, userId: string): Promise<number> {
  return (await getPlayer(h.db, ROOM_ID, userId))!.hp;
}

async function eventsOf(h: Harness) {
  return readEvents((await getRoom(h.db, ROOM_ID))!);
}

async function resultRows(
  h: Harness,
): Promise<{ user_id: string; rank: number; hp_remaining: number; spells_cast: number }[]> {
  return h.db
    .select({
      user_id: results.user_id,
      rank: results.rank,
      hp_remaining: results.hp_remaining,
      spells_cast: results.spells_cast,
    })
    .from(results)
    .orderBy(results.user_id);
}

beforeEach(() => {
  now = T0;
  setSystemTime(now);
});

describe('窗口与游标', () => {
  it('提交当刻推进法术游标，伤害与事件等到窗口末才一次性落地', async () => {
    const h = await startCombat(['a', 'b', 'c']);
    await h.cast('a', 0);

    expect(await getPlayer(h.db, ROOM_ID, 'a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
    });
    for (const id of ['a', 'b', 'c']) expect(await hpOf(h, id)).toBe(INITIAL_HEALTH);
    expect(await eventsOf(h)).toEqual([]);

    h.at(50);
    await advanceOnce(h.scope);
    for (const id of ['a', 'b', 'c']) expect(await hpOf(h, id)).toBe(INITIAL_HEALTH);
    expect(await eventsOf(h)).toEqual([]);

    h.at(100);
    await advanceOnce(h.scope);
    // 一发总伤 16，三人局均摊给另两人：每人恰好 8。
    expect(await hpOf(h, 'b')).toBe((FULL - 48) / SCALE);
    expect(await hpOf(h, 'c')).toBe((FULL - 48) / SCALE);
    expect(await hpOf(h, 'a')).toBe(INITIAL_HEALTH);
  });
});

describe('固定总伤均分', () => {
  it('三人局对半、四人局三等分，全部落在整数六分之一血格上', async () => {
    const three = await startCombat(['a', 'b', 'c']);
    await three.cast('a', 0);
    three.at(100);
    await advanceOnce(three.scope);

    const events = (await eventsOf(three)).sort((x, y) => x.targetId.localeCompare(y.targetId));
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

    const four = await startCombat(['a', 'b', 'c', 'd']);
    await four.cast('a', 0);
    four.at(100);
    await advanceOnce(four.scope);

    for (const id of ['b', 'c', 'd']) {
      expect(await hpOf(four, id)).toBe((FULL - 32) / SCALE);
    }
    expect(await hpOf(four, 'a')).toBe(INITIAL_HEALTH);
    expect((await eventsOf(four)).reduce((sum, event) => sum + event.damage, 0)).toBeCloseTo(
      TOTAL_POWER,
      6,
    );
  });

  it('伤害不偏置座位：任一座位施法，其余存活者都均摊同额', async () => {
    // 施法者在末位：老规则只会打顺时针下家，新规则打其余全部。
    const fromLast = await startCombat(['a', 'b', 'c', 'd']);
    await fromLast.cast('d', 0);
    fromLast.at(100);
    await advanceOnce(fromLast.scope);
    for (const id of ['a', 'b', 'c']) {
      expect(await hpOf(fromLast, id)).toBe((FULL - 32) / SCALE);
    }

    // 同一批人换成施法者坐首位，结果逐座位相同：座位排列不影响分摊。
    const fromFirst = await startCombat(['d', 'a', 'b', 'c']);
    await fromFirst.cast('d', 0);
    fromFirst.at(100);
    await advanceOnce(fromFirst.scope);
    for (const id of ['a', 'b', 'c']) {
      expect(await hpOf(fromFirst, id)).toBe((FULL - 32) / SCALE);
    }
  });

  it('三分之一血长程重复不漂移：每一步都落在整数六分之一血格上', async () => {
    const h = await startCombat(['a', 'b', 'c', 'd']);
    await updateRoom(h.db, ROOM_ID, { spell_book: JSON.stringify(BOOK.slice(0, 2)) });
    // b 只剩 100（600 六分之一格）：第 19 发命中时越界致死，此后人数收缩改变分母。
    await updatePlayer(h.db, ROOM_ID, 'b', { hp: 100 });
    for (let step = 1; step <= 40; step += 1) {
      h.at((step - 1) * 100);
      await h.cast('a', step - 1);
      h.at(step * 100);
      await advanceOnce(h.scope);

      expect(await hpOf(h, 'b')).toBe(Math.max(0, 600 - 32 * step) / SCALE);
      const expected = FULL - 32 * Math.min(step, 19) - 48 * Math.max(0, step - 19);
      expect(await hpOf(h, 'c')).toBe(expected / SCALE);
      expect(await hpOf(h, 'd')).toBe(expected / SCALE);
      if (step === 19) {
        expect(
          (await eventsOf(h)).filter((event) => event.targetId === 'b' && event.eliminated),
        ).toHaveLength(1);
      }
    }
    expect(await getPlayer(h.db, ROOM_ID, 'b')).toMatchObject({
      eliminated_at: T0 + 1_900,
    });
    expect(await getPlayer(h.db, ROOM_ID, 'a')).toMatchObject({
      spell_index: 40,
      spells_cast: 40,
    });
  });
});

describe('同窗致死与结算', () => {
  it('同窗互致致命：双方提交都被接受，同批同时归零并共享第一', async () => {
    const h = await startCombat(['a', 'b']);
    await updatePlayer(h.db, ROOM_ID, 'a', { hp: 10 });
    await updatePlayer(h.db, ROOM_ID, 'b', { hp: 10 });

    await h.cast('a', 0);
    await h.cast('b', 0);
    // 双方都在同一窗口提交并被接受，伤害仍未生效。
    expect(await getPlayer(h.db, ROOM_ID, 'a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
    });
    expect(await getPlayer(h.db, ROOM_ID, 'b')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
    });
    expect(await hpOf(h, 'a')).toBe(10);
    expect(await hpOf(h, 'b')).toBe(10);

    h.at(100);
    await advanceOnce(h.scope);

    const room = (await getRoom(h.db, ROOM_ID))!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('elimination');
    expect(room.ended_at).toBe(T0 + 100);
    expect(await hpOf(h, 'a')).toBe(0);
    expect(await hpOf(h, 'b')).toBe(0);
    expect(await getPlayer(h.db, ROOM_ID, 'a')).toMatchObject({
      eliminated_at: T0 + 100,
    });
    expect(await getPlayer(h.db, ROOM_ID, 'b')).toMatchObject({
      eliminated_at: T0 + 100,
    });

    const events = await eventsOf(h);
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

    const snapshot = await snapshotFor(h.db, ROOM_ID, h.registry, { id: 'a', username: 'a' });
    expect(
      snapshot.players.toSorted((x, y) => x.id.localeCompare(y.id)).map((p) => [p.id, p.rank]),
    ).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
    expect(
      (await resultRows(h))
        .sort((x, y) => x.user_id.localeCompare(y.user_id))
        .map((row) => [row.user_id, row.rank]),
    ).toEqual([
      ['a', 1],
      ['b', 1],
    ]);

    // 终局之后的下一次攻击被整体拒绝：游标、计数与事件都不再移动。
    const eventsBefore = await eventsOf(h);
    await h.cast('a', 1);
    expect(await getPlayer(h.db, ROOM_ID, 'a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
    });
    expect(await eventsOf(h)).toEqual(eventsBefore);
    expect(await getRoom(h.db, ROOM_ID)).toMatchObject({ phase: 'finished' });
  });

  it('上一窗到点先于下一窗输入结算：先落地的伤害与后入队的施法互不污染', async () => {
    const h = await startCombat(['a', 'b', 'c']);
    await updatePlayer(h.db, ROOM_ID, 'b', { hp: 8 }); // 一发对半，恰好致死 b
    await h.cast('a', 0);

    h.at(100);
    // 下一窗的施法先到：handleInput 必须先把到期的批次结清，再接受这次施法。
    await h.cast('c', 0);

    expect(await getPlayer(h.db, ROOM_ID, 'b')).toMatchObject({
      eliminated_at: T0 + 100,
    });
    expect(await hpOf(h, 'c')).toBe(INITIAL_HEALTH - 8);
    expect((await eventsOf(h)).map((event) => [event.attackerId, event.at])).toEqual([
      ['a', T0 + 100],
      ['a', T0 + 100],
    ]);

    // c 的施法在已结清的新窗口里等待，到点后作为独立一批落地。
    h.at(200);
    await advanceOnce(h.scope);
    const events = await eventsOf(h);
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({
      seq: events[1].seq + 1,
      at: T0 + 200,
      attackerId: 'c',
      targetId: 'a',
      spellIndex: 0,
    });
    // a 在第一批里是施法者（自身免疫），只在第二批挨 c 的全额一击。
    expect(await hpOf(h, 'a')).toBe(INITIAL_HEALTH - 16);
    expect(await getRoom(h.db, ROOM_ID)).toMatchObject({ phase: 'playing' });
  });

  it('截限前最后一窗先结算再按超时收尾；截限后的输入不再接受', async () => {
    const h = await startCombat(['a', 'b']);
    h.at(MATCH_DURATION_MS - 50); // 窗口末被截限封顶：批次恰好在截限时刻到期
    await h.cast('a', 0);

    h.at(MATCH_DURATION_MS);
    await advanceOnce(h.scope);

    const room = (await getRoom(h.db, ROOM_ID))!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('timeout');
    expect(room.ended_at).toBe(COMBAT_END);
    expect(await hpOf(h, 'b')).toBe(INITIAL_HEALTH - TOTAL_POWER);
    const events = await eventsOf(h);
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
    expect(await getPlayer(h.db, ROOM_ID, 'b')).toMatchObject({
      spell_index: 0,
      spells_cast: 0,
    });
    expect(await eventsOf(h)).toEqual(events);
  });

  it('截限当刻到期的致死批次按淘汰收尾，而不是超时', async () => {
    const h = await startCombat(['a', 'b']);
    await updatePlayer(h.db, ROOM_ID, 'b', { hp: TOTAL_POWER });
    h.at(MATCH_DURATION_MS - 50);
    await h.cast('a', 0);

    h.at(MATCH_DURATION_MS);
    await advanceOnce(h.scope);

    const room = (await getRoom(h.db, ROOM_ID))!;
    expect(room).toMatchObject({
      phase: 'finished',
      end_reason: 'elimination',
      ended_at: COMBAT_END,
    });
    expect(await hpOf(h, 'b')).toBe(0);
    expect(await getPlayer(h.db, ROOM_ID, 'b')).toMatchObject({
      eliminated_at: COMBAT_END,
    });
    const snapshot = await snapshotFor(h.db, ROOM_ID, h.registry, { id: 'a', username: 'a' });
    expect(
      snapshot.players.toSorted((x, y) => x.id.localeCompare(y.id)).map((p) => [p.id, p.rank]),
    ).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });

  it('结局快照：血量相同即并列，产出差异不打破生存并列', async () => {
    const h = await startCombat(['a', 'b', 'c', 'd']);
    await updatePlayer(h.db, ROOM_ID, 'a', {
      spell_index: 2,
      input_not_before: T0 + BOOK[2].text.length * INPUT_MIN_MS_PER_CODE_POINT,
    });
    // 第一窗（四人分母 3）：a 施放十二字大咒，b、c、d 各挨 16，a 全额入账 48。
    await h.cast('a', 2);
    h.at(100);
    await advanceOnce(h.scope);
    expect(await hpOf(h, 'b')).toBe((FULL - 96) / SCALE);

    // 恰在窗口边界弃赛：d 的名字从此不在名册里，第二窗缩成三人分母。
    await manualLeave(h.scope, 'd');
    expect(await hpOf(h, 'd')).toBe(0);
    expect(await getPlayer(h.db, ROOM_ID, 'd')).toMatchObject({
      eliminated_at: T0 + 100,
    });

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
    const snapshot = await snapshotFor(h.db, ROOM_ID, h.registry, { id: 'a', username: 'a' });
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
  it('对同一份持久数据库重开实例：待结算批次不丢、不重', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spelltype-volley-restart-'));
    try {
      const first = await openTestDb(dir);
      await seedMatchState(first.db, ['a', 'b']);
      const firstRun = combatHarness(first.db, ['a', 'b']);
      await firstRun.cast('a', 0);
      // 待结算批次是持久状态：整个实例连同连接一起关闭。
      await first.close();
      databases.splice(databases.indexOf(first), 1);

      // 新实例对同一文件重跑迁移，只挂新连接与新 scope。
      const reopened = await openTestDb(dir);
      const second = combatHarness(reopened.db, ['a', 'b']);
      const room = (await getRoom(second.db, ROOM_ID))!;
      expect(room).toMatchObject({ phase: 'playing', match_id: MATCH_ID, started_at: T0 });
      expect(await getPlayer(second.db, ROOM_ID, 'a')).toMatchObject({
        spell_index: 1,
        spells_cast: 1,
      });
      expect(await hpOf(second, 'b')).toBe(INITIAL_HEALTH);

      second.at(100);
      await advanceOnce(second.scope);
      expect(await hpOf(second, 'b')).toBe(INITIAL_HEALTH - TOTAL_POWER);
      expect(await eventsOf(second)).toHaveLength(1);

      // 再走一遍不会再落一次：批次恰好结算一次。
      await advanceOnce(second.scope);
      expect(await hpOf(second, 'b')).toBe(INITIAL_HEALTH - TOTAL_POWER);
      expect(await eventsOf(second)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('窗口内弃赛：已提交的施法保留承诺，其分摊被弃置而不转嫁', async () => {
    const h = await startCombat(['a', 'b', 'c']);
    await h.cast('a', 0); // 名册在窗口首个施法时冻结为 [a, b, c]
    h.at(40);
    await manualLeave(h.scope, 'b');
    expect(await hpOf(h, 'b')).toBe(0);
    expect(await getPlayer(h.db, ROOM_ID, 'b')).toMatchObject({
      eliminated_at: T0 + 40,
    });
    expect(await getRoom(h.db, ROOM_ID)).toMatchObject({ phase: 'playing' });

    h.at(100);
    await advanceOnce(h.scope);
    // b 的份额被弃置而非转嫁：c 只收到一半（8），没有人替 b 挨满 16。
    expect(await hpOf(h, 'c')).toBe((FULL - 48) / SCALE);
    expect(await hpOf(h, 'a')).toBe(INITIAL_HEALTH);
    expect(await hpOf(h, 'b')).toBe(0);
    const events = await eventsOf(h);
    expect(events.map((event) => [event.attackerId, event.targetId])).toEqual([['a', 'c']]);
    expect(events[0]).toMatchObject({
      damage: 8,
      targetHp: INITIAL_HEALTH - 8,
      eliminated: false,
    });
    expect(await getPlayer(h.db, ROOM_ID, 'a')).toMatchObject({ damage_dealt: 8 });
    expect(await getPlayer(h.db, ROOM_ID, 'b')).toMatchObject({ damage_dealt: 0 });
  });

  it('双人局最后对手弃赛：结算等已提交批次落地后再收尾', async () => {
    const h = await startCombat(['a', 'b']);
    await h.cast('a', 0);
    h.at(40);
    await manualLeave(h.scope, 'b');
    expect(await getPlayer(h.db, ROOM_ID, 'b')).toMatchObject({
      eliminated_at: T0 + 40,
    });
    // 还有未结算批次：房间等待批次落地，而不是在批次之下收尾。
    expect(await getRoom(h.db, ROOM_ID)).toMatchObject({ phase: 'playing' });

    h.at(100);
    await advanceOnce(h.scope);
    const room = (await getRoom(h.db, ROOM_ID))!;
    expect(room.phase).toBe('finished');
    expect(room.end_reason).toBe('elimination');
    // 弃赛不回滚已接受的施法：游标与计数保持推进；没有任何伤害转嫁到施法者自己身上。
    expect(await getPlayer(h.db, ROOM_ID, 'a')).toMatchObject({
      spell_index: 1,
      spells_cast: 1,
      hp: INITIAL_HEALTH,
      damage_dealt: 0,
    });
    // b 已弃赛：批次没有任何可命中对象，事件为空也不算丢失。
    expect(await eventsOf(h)).toEqual([]);
    const rows = await resultRows(h);
    expect(
      rows
        .toSorted((x, y) => x.user_id.localeCompare(y.user_id))
        .map((row) => [row.user_id, row.rank, row.spells_cast]),
    ).toEqual([
      ['a', 1, 1],
      ['b', 2, 0],
    ]);
    expect(rows.find((row) => row.user_id === 'b')!.hp_remaining).toBe(0);
  });
});

afterEach(async () => {
  try {
    await Promise.all(databases.splice(0).map((database) => database.close()));
  } finally {
    setSystemTime();
  }
});
