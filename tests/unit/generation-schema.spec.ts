/**
 * Spell-book validation unit tests — the one gate between a model response and a live match.
 *
 * The gate is deliberately loose where the model is unreliable: the difficulty length bands are
 * prompt guidance only, and the lengths the real endpoint actually produces (measured ~14-24
 * chars per book, usually below the normal/hard bands) must reach players. Structure, count,
 * dedup, the typable character set and a loose length ceiling stay hard. A rejected candidate
 * is retried once and then reported as its own failure category, so this validation decides both
 * whether a match can start and whether a bad payload can reach players. Nothing here needs a
 * provider: `validateSpellSet` is pure.
 */
import { describe, expect, it } from 'vitest';
import { validateSpellSet } from '../../worker/generation/spells';
import { SPELL_BOOK_SIZE, type Spell } from '../../shared/protocol';

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

function rejection(candidate: unknown): string | null {
  const result = validateSpellSet(candidate);
  return result.ok ? null : result.detail;
}

/** The candidate is untrusted model output, so it is built as raw data rather than as a Spell. */
function withFirst(over: Record<string, unknown>): { spells: unknown[] } {
  const spells = book(20);
  return { spells: [{ ...spells[0], ...over }, ...spells.slice(1)] };
}

describe('咒文书校验', () => {
  it('接受真实模型实际产出的长度：14-24 字的整本书不再因难度下限被拒', () => {
    // Short model sentences and the former difficulty bands must both remain playable.
    for (const length of [14, 16, 20, 24, 27, 38, 50]) {
      expect(rejection({ spells: book(length) }), `length ${length}`).toBeNull();
    }
  });

  it('宽松上限与空文本仍然拒绝：超过 64 码点或空咒文不可进入对局', () => {
    expect(rejection({ spells: book(64) })).toBeNull();
    expect(rejection({ spells: book(65) })).toBe('text-length:65');
    expect(rejection(withFirst({ text: '   ' }))).toBe('text-empty');
    expect(rejection(withFirst({ text: '' }))).toBe('text-empty');
  });

  it('模型输出的首尾空白被规整而不是拒绝，句末标点允许', () => {
    const text = '以霜雪为契，凝聚月华；「星光」护佑此身！';
    const trimmed = validateSpellSet(withFirst({ text: ` ${text}\n`, name: ' 月华守护 ' }));
    expect(trimmed.ok).toBe(true);
    if (trimmed.ok) {
      expect(trimmed.spells[0].text).toBe(text);
      expect(trimmed.spells[0].name).toBe('月华守护');
    }
  });

  it('数量不足、过多或结构不对都被拒绝', () => {
    const tooFew = book();
    tooFew.pop();
    expect(rejection({ spells: tooFew })).toBe('count');
    expect(rejection({ spells: [...book(), book()[0]] })).toBe('count');
    expect(rejection({})).toBe('count');
    expect(rejection(null)).toBe('not-an-object');
  });

  it('重复的咒文与重复的名称都被拒绝', () => {
    const repeatedText = book();
    repeatedText[1] = { ...repeatedText[1], text: repeatedText[0].text };
    expect(rejection({ spells: repeatedText })).toBe('duplicate-text');

    const repeatedName = book();
    repeatedName[1] = { ...repeatedName[1], name: repeatedName[0].name };
    expect(rejection({ spells: repeatedName })).toBe('duplicate-name');
  });

  it('咒文与名称的字符集、名称长度、元素枚举与字段形状都被校验', () => {
    // 汉字与中文标点之外的一切都是拒绝项；emoji 同时证明长度按码点而不是 UTF-16 计数。
    expect(rejection(withFirst({ text: `${hanRun(20, 0)}a` }))).toBe('text-chars');
    expect(rejection(withFirst({ text: `${hanRun(20, 0)}🌸` }))).toBe('text-chars');
    expect(rejection(withFirst({ name: '炎' }))).toBe('name-length:1');
    expect(rejection(withFirst({ name: HAN.slice(0, 13) }))).toBe('name-length:13');
    expect(rejection(withFirst({ name: '炎爆abc' }))).toBe('name-chars');
    expect(rejection(withFirst({ element: 'light' }))).toBe('element');
    expect(rejection(withFirst({ text: undefined }))).toBe('types');
    expect(rejection({ spells: ['not-a-spell', ...book(20).slice(1)] })).toBe('entry');
  });
});
