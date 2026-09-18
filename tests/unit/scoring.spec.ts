/**
 * Combat rules unit tests — the numbers the room is authoritative for, without a room.
 *
 * Only the rules a plausible bug would silently break: code-point accounting, the edit-diff that
 * turns a typed snapshot into attempts/errors/progress, automatic clockwise targeting, competition
 * ranks and the two aggregate figures that reach the results table.
 */
import { describe, expect, it } from 'vitest';
import {
  accuracyOf,
  charCount,
  cpmOf,
  damageOf,
  diffSnapshot,
  nextAliveBySeat,
  spellAt,
  survivalRanks,
  type MatchStanding,
} from '../../worker/scoring';

describe('咒文长度与伤害', () => {
  it('按 Unicode 码点计数，代理对算一个字符，伤害是码点的四倍', () => {
    expect(charCount('咒文对决')).toBe(4);
    expect(charCount('a𠮷b')).toBe(3);
    expect(charCount('\uD800')).toBe(1);
    expect(damageOf('咒文')).toBe(8);
    expect(damageOf('𠮷')).toBe(4);
  });
});

describe('法术游标', () => {
  const book = [
    { name: '甲', text: '甲咒', translation: '甲咒', element: 'fire' as const },
    { name: '乙', text: '乙咒', translation: '乙咒', element: 'ice' as const },
  ];

  it('按私有下标取书中的法术，下标越界后回绕到同一本书', () => {
    expect(spellAt(book, 0)?.name).toBe('甲');
    expect(spellAt(book, 1)?.name).toBe('乙');
    expect(spellAt(book, 2)?.name).toBe('甲');
    expect(spellAt(book, 5)?.name).toBe('乙');
  });

  it('没有法术书时没有当前法术', () => {
    expect(spellAt([], 0)).toBeNull();
  });
});

describe('输入快照差异', () => {
  it('重复快照不产生任何计入，因此重连与重复投递不会灌水统计', () => {
    expect(diffSnapshot('咒文对决', '咒文对决', '咒文对决')).toEqual({
      inserted: 0,
      deleted: 0,
      errors: 0,
      progress: 4,
    });
  });

  it('追加正确字符只推进已确认前缀', () => {
    expect(diffSnapshot('咒文', '咒文对决', '咒文对决')).toEqual({
      inserted: 2,
      deleted: 0,
      errors: 0,
      progress: 4,
    });
  });

  it('错误字符计入错误，但不推进已确认前缀', () => {
    expect(diffSnapshot('咒文', '咒文错', '咒文对决')).toEqual({
      inserted: 1,
      deleted: 0,
      errors: 1,
      progress: 2,
    });
  });

  it('纯删除只计删除：既不算尝试，也不算错误', () => {
    expect(diffSnapshot('咒文对决', '咒文', '咒文对决')).toEqual({
      inserted: 0,
      deleted: 2,
      errors: 0,
      progress: 2,
    });
  });

  it('选区替换是一插一删，两侧未改动的部分被保留', () => {
    expect(diffSnapshot('abcd', 'abXd', 'abcd')).toEqual({
      inserted: 1,
      deleted: 1,
      errors: 1,
      progress: 2,
    });
  });

  it('代理对按码点比较，半个字符不会被当成匹配', () => {
    expect(diffSnapshot('', '文', '𠮷文')).toEqual({
      inserted: 1,
      deleted: 0,
      errors: 1,
      progress: 0,
    });
  });
});

describe('自动目标', () => {
  const seats = [
    { slot: 0, id: 'a' },
    { slot: 1, id: 'b' },
    { slot: 2, id: 'c' },
    { slot: 3, id: 'd' },
  ];
  const aliveExcept =
    (...dead: number[]) =>
    (seat: { slot: number }) =>
      !dead.includes(seat.slot);

  it('取座位顺时针的下一个存活玩家，跳过出局者并跨过座位表回绕', () => {
    expect(nextAliveBySeat(seats, 0, aliveExcept())?.id).toBe('b');
    expect(nextAliveBySeat(seats, 0, aliveExcept(1, 2))?.id).toBe('d');
    expect(nextAliveBySeat(seats, 3, aliveExcept())?.id).toBe('a');
    expect(nextAliveBySeat(seats, 3, aliveExcept(0, 1))?.id).toBe('c');
  });

  it('没有其他存活玩家时没有目标', () => {
    expect(nextAliveBySeat(seats, 0, aliveExcept(1, 2, 3))).toBeNull();
  });
});

describe('最终名次', () => {
  const standing = (userId: string, over: Partial<MatchStanding> = {}): MatchStanding => ({
    userId,
    hp: 2400,
    damageDealt: 0,
    correctChars: 0,
    eliminatedAt: null,
    ...over,
  });

  it('存活者按剩余生命、伤害、确认字符排序，并列共享名次并跳号', () => {
    const ranks = survivalRanks([
      standing('tied-a'),
      standing('tied-b'),
      standing('most-damage', { damageDealt: 20, correctChars: 5 }),
      standing('most-chars', { damageDealt: 20, correctChars: 9 }),
      standing('hurt', { hp: 100 }),
    ]);
    expect(ranks.get('most-chars')).toBe(1);
    expect(ranks.get('most-damage')).toBe(2);
    expect(ranks.get('tied-a')).toBe(3);
    expect(ranks.get('tied-b')).toBe(3);
    expect(ranks.get('hurt')).toBe(5);
  });

  it('出局者排在所有存活者之后，出局越晚名次越高，同时出局共享名次', () => {
    const ranks = survivalRanks([
      standing('winner'),
      standing('late', { hp: 0, eliminatedAt: 900 }),
      standing('early', { hp: 0, eliminatedAt: 100 }),
      standing('together', { hp: 0, eliminatedAt: 100 }),
    ]);
    expect(ranks.get('winner')).toBe(1);
    expect(ranks.get('late')).toBe(2);
    expect(ranks.get('early')).toBe(3);
    expect(ranks.get('together')).toBe(3);
  });
});

describe('聚合指标', () => {
  it('没有作答时准确率未知，修正保留错误，且夹在 0 与 1 之间', () => {
    expect(accuracyOf(0, 0)).toBeNull();
    expect(accuracyOf(9, 1)).toBeCloseTo(0.8889, 3);
    expect(accuracyOf(1, 5)).toBe(0);
  });

  it('CPM 是活跃时间内的每分钟确认字符数，取整', () => {
    expect(cpmOf(120, 0)).toBe(0);
    expect(cpmOf(100, 60)).toBe(100);
    expect(cpmOf(100, 90)).toBe(67);
  });
});
