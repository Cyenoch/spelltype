/**
 * 战斗规则单元测试 —— 脱离房间实体直接测试房间所权威负责的核心数值。
 *
 * 仅测试潜在 bug 会静默破坏的规则：码点统计、将打字快照转化为尝试数/错误数/进度的编辑差量算法、
 * 竞技名次计算以及最终落库到 results 表的两个聚合指标。
 * 目标选择本身不再属于计分关注点：一次施法的威力会作用于其他所有存活玩家，该规则的批量执行已由房间级齐射回归测试套件全面覆盖。
 */
import { describe, expect, it } from 'bun:test';
import {
  accuracyOf,
  charCount,
  cpmOf,
  damageOf,
  diffSnapshot,
  inputCompletionRatio,
  inputNotBefore,
  spellAt,
  survivalRanks,
  type MatchStanding,
} from '../../server/scoring';

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

describe('最终名次', () => {
  const standing = (userId: string, over: Partial<MatchStanding> = {}): MatchStanding => ({
    userId,
    hp: 2400,
    eliminatedAt: null,
    ...over,
  });

  it('存活者只按剩余生命排名，同血即并列共享名次并跳号', () => {
    const ranks = survivalRanks([
      standing('tied-a'),
      standing('tied-b'),
      standing('more-damage'),
      standing('most-chars'),
      standing('hurt', { hp: 100 }),
    ]);
    // 输出统计不再是名次的输入：四个满血幸存者并列第一，掉血者垫底并跳号。
    expect(ranks.get('tied-a')).toBe(1);
    expect(ranks.get('tied-b')).toBe(1);
    expect(ranks.get('more-damage')).toBe(1);
    expect(ranks.get('most-chars')).toBe(1);
    expect(ranks.get('hurt')).toBe(5);
  });

  it('出局者排在所有存活者之后，出局越晚名次越高，同一批次共享名次', () => {
    const ranks = survivalRanks([
      standing('winner'),
      standing('late', { hp: 0, eliminatedAt: 900 }),
      standing('early', { hp: 0, eliminatedAt: 100 }),
      standing('same-batch', { hp: 0, eliminatedAt: 100 }),
    ]);
    expect(ranks.get('winner')).toBe(1);
    expect(ranks.get('late')).toBe(2);
    expect(ranks.get('early')).toBe(3);
    expect(ranks.get('same-batch')).toBe(3);
  });

  it('最后的幸存者互相击倒时，同批双亡共享第一', () => {
    const ranks = survivalRanks([
      standing('mutual-a', { hp: 0, eliminatedAt: 500 }),
      standing('mutual-b', { hp: 0, eliminatedAt: 500 }),
    ]);
    expect(ranks.get('mutual-a')).toBe(1);
    expect(ranks.get('mutual-b')).toBe(1);
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

describe('施法时间门槛', () => {
  const OPENED = 1_700_000_000_000;

  it('资格时刻是开启时刻加目标码点数乘每码点成本', () => {
    expect(inputNotBefore(50, OPENED, 35)).toBe(OPENED + 1_750);
    expect(inputNotBefore(1, OPENED, 35)).toBe(OPENED + 35);
    // 安全整数边界：结果恰好到达上限仍然合法。
    expect(inputNotBefore(1, Number.MAX_SAFE_INTEGER - 35, 35)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('首次完成资格比值是真实经过时间与规则成本的商，开启前为零', () => {
    expect(inputCompletionRatio(50, OPENED, OPENED + 1_750, 35)).toBe(1);
    expect(inputCompletionRatio(50, OPENED, OPENED + 875, 35)).toBe(0.5);
    expect(inputCompletionRatio(50, OPENED, OPENED, 35)).toBe(0);
    expect(inputCompletionRatio(50, OPENED, OPENED - 10_000, 35)).toBe(0);
  });

  it('比值不取整也不封顶：它是策略指标，不是作弊分数', () => {
    expect(inputCompletionRatio(50, OPENED, OPENED + 1_749, 35)).toBe(1_749 / 1_750);
    expect(inputCompletionRatio(1, OPENED, OPENED + 3_500_000, 35)).toBe(100_000);
  });

  it('零成本与零长度不是就绪：非法状态抛 input_gate_state_invalid', () => {
    expect(() => inputNotBefore(0, OPENED, 35)).toThrow('input_gate_state_invalid');
    expect(() => inputNotBefore(-1, OPENED, 35)).toThrow('input_gate_state_invalid');
    expect(() => inputNotBefore(50, OPENED, 0)).toThrow('input_gate_state_invalid');
    expect(() => inputNotBefore(50, OPENED, 35.5)).toThrow('input_gate_state_invalid');
    expect(() => inputCompletionRatio(0, OPENED, OPENED + 35, 35)).toThrow(
      'input_gate_state_invalid',
    );
    expect(() => inputCompletionRatio(50, OPENED, OPENED + 35, 0)).toThrow(
      'input_gate_state_invalid',
    );
  });

  it('非整数与非有限时间非法，资格结果溢出安全整数即拒绝', () => {
    expect(() => inputNotBefore(50.5, OPENED, 35)).toThrow('input_gate_state_invalid');
    expect(() => inputNotBefore(50, Number.NaN, 35)).toThrow('input_gate_state_invalid');
    expect(() => inputNotBefore(50, Number.POSITIVE_INFINITY, 35)).toThrow(
      'input_gate_state_invalid',
    );
    expect(() => inputNotBefore(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, 35)).toThrow(
      'input_gate_state_invalid',
    );
    expect(() => inputCompletionRatio(50, Number.NaN, OPENED, 35)).toThrow(
      'input_gate_state_invalid',
    );
    expect(() => inputCompletionRatio(50, OPENED, Number.POSITIVE_INFINITY, 35)).toThrow(
      'input_gate_state_invalid',
    );
    expect(() => inputCompletionRatio(50, OPENED, OPENED + 0.5, 35)).toThrow(
      'input_gate_state_invalid',
    );
  });
});
