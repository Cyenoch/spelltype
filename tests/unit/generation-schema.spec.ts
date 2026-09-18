/**
 * Spell-book validation unit tests — the one gate between a model response and a live match.
 *
 * A rejected candidate is retried once and then reported as its own failure category, so this
 * validation decides both whether a match can start and whether a bad payload can reach players.
 * Nothing here needs a provider: `validateSpellSet` is pure.
 */
import { describe, expect, it } from 'vitest';
import { DIFFICULTY_LENGTH, validateSpellSet } from '../../worker/generation/spells';
import { SPELL_BOOK_SIZE, type Difficulty, type Spell } from '../../shared/protocol';

const HAN = '霜月幽炎雷渊灵焰寒星冥绮岚晞辰暮曦云雾雨雪风花叶露金木水火土山河海川岩石';
const NAME_BASES = ['炎爆术', '霜缚咒', '雷引诀', '幽影环', '星辉印', '冰封界', '风吟诀', '月蚀咒'];

function hanRun(length: number, offset: number): string {
  let text = '';
  while (text.length < length) text += HAN[(offset + text.length) % HAN.length];
  return text;
}

/** A conforming book whose spells are `length` characters long, distinct in text and name. */
function book(length = 27): Spell[] {
  return Array.from({ length: SPELL_BOOK_SIZE }, (_, index) => ({
    name: `${NAME_BASES[index % NAME_BASES.length]}${HAN[index % HAN.length]}`,
    text: hanRun(length, index),
    element: (['arcane', 'fire', 'ice', 'storm'] as const)[index % 4],
  }));
}

function rejection(candidate: unknown, difficulty: Difficulty): string | null {
  const result = validateSpellSet(candidate, difficulty);
  return result.ok ? null : result.detail;
}

describe('咒文书校验', () => {
  it('每个难度的完整书都被接受，区间边界按码点包含，越界即被拒绝', () => {
    for (const difficulty of ['easy', 'normal', 'hard'] as const) {
      const rule = DIFFICULTY_LENGTH[difficulty];
      const result = validateSpellSet({ spells: book(rule.min) }, difficulty);
      expect(result.ok, difficulty).toBe(true);
      if (result.ok) expect(result.spells).toHaveLength(SPELL_BOOK_SIZE);
      expect(rejection({ spells: book(rule.max) }, difficulty)).toBeNull();
      expect(rejection({ spells: book(rule.min - 1) }, difficulty)).toBe(
        `text-length:${rule.min - 1}`,
      );
      expect(rejection({ spells: book(rule.max + 1) }, difficulty)).toBe(
        `text-length:${rule.max + 1}`,
      );
    }
    // 区间属于房间声明的难度：同一本书在另一档难度下不必成立。
    expect(rejection({ spells: book(DIFFICULTY_LENGTH.easy.min) }, 'hard')).toBe(
      `text-length:${DIFFICULTY_LENGTH.easy.min}`,
    );
  });

  it('数量不足、过多或结构不对都被拒绝', () => {
    const tooFew = book();
    tooFew.pop();
    expect(rejection({ spells: tooFew }, 'normal')).toBe('count');
    expect(rejection({ spells: [...book(), book()[0]] }, 'normal')).toBe('count');
    expect(rejection({}, 'normal')).toBe('count');
    expect(rejection(null, 'normal')).toBe('not-an-object');
  });

  it('重复的咒文与重复的名称都被拒绝', () => {
    const repeatedText = book();
    repeatedText[1] = { ...repeatedText[1], text: repeatedText[0].text };
    expect(rejection({ spells: repeatedText }, 'normal')).toBe('duplicate-text');

    const repeatedName = book();
    repeatedName[1] = { ...repeatedName[1], name: repeatedName[0].name };
    expect(rejection({ spells: repeatedName }, 'normal')).toBe('duplicate-name');
  });

  it('咒文与名称的字符集、名称长度、元素枚举与字段形状都被校验', () => {
    // The candidate is untrusted model output, so it is built as raw data rather than as a Spell.
    const withFirst = (over: Record<string, unknown>): unknown => {
      const spells = book(DIFFICULTY_LENGTH.easy.min);
      return { spells: [{ ...spells[0], ...over }, ...spells.slice(1)] };
    };

    // 汉字与中文标点之外的一切都是拒绝项；emoji 同时证明长度按码点而不是 UTF-16 计数。
    expect(rejection(withFirst({ text: `${hanRun(17, 0)}a` }), 'easy')).toBe('text-chars');
    expect(rejection(withFirst({ text: `${hanRun(17, 0)}🌸` }), 'easy')).toBe('text-chars');
    expect(rejection(withFirst({ text: `${hanRun(17, 0)}。` }), 'easy')).toBeNull();

    expect(rejection(withFirst({ name: '炎' }), 'easy')).toBe('name-length:1');
    expect(rejection(withFirst({ name: HAN.slice(0, 13) }), 'easy')).toBe('name-length:13');
    expect(rejection(withFirst({ name: '炎爆abc' }), 'easy')).toBe('name-chars');

    expect(rejection(withFirst({ element: 'light' }), 'easy')).toBe('element');
    expect(rejection(withFirst({ text: undefined }), 'easy')).toBe('types');
    expect(
      rejection({ spells: ['not-a-spell', ...book(DIFFICULTY_LENGTH.easy.min).slice(1)] }, 'easy'),
    ).toBe('entry');
  });
});
