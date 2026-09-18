/**
 * Spell-book validation unit tests — the one gate between a model response and a live match.
 *
 * The gate is deliberately loose where the model is unreliable: the 39-50 length target and the
 * !/~ ending style are prompt guidance only, and the lengths the model actually produces must
 * reach players. Structure, count, dedup, the printable-ASCII character set on name/text, the
 * real-Chinese translation metadata and the loose length ceilings stay hard, so Chinese typing
 * text, full-width punctuation, emoji and control characters can never enter the English combat
 * data. A rejected candidate is retried once and then reported as its own failure category, so
 * this validation decides both whether a match can start and whether a bad payload can reach
 * players. Nothing here needs a provider: `validateSpellSet` is pure.
 */
import { describe, expect, it } from 'bun:test';
import { validateSpellSet } from '../../server/generation/spells';
import { SPELL_BOOK_SIZE, type Spell } from '../../shared/protocol';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const NAME_BASES = [
  'Ember Bolt',
  'Frost Bind',
  'Storm Call',
  'Raven Mark',
  'Star Sigil',
  'Ice Veil',
  'Wind Verse',
  'Moon Eclipse',
];
const ZH_BASES = [
  '燃起余烬之焰',
  '冻结来敌脚步',
  '召来风暴轰击',
  '以鸦羽刻下印记',
  '星光结成封印',
  '寒冰织成面纱',
  '风吟成诗',
  '月影吞没一切',
];

/**
 * An exact-`length` code point run of ASCII pseudo-words (4-letter groups split by spaces) whose
 * first letter is fixed by `offset`, so books of any length stay distinct and never end in a space.
 */
function wordRun(length: number, offset: number): string {
  let text = '';
  while (text.length < length) {
    if (text.length > 0 && length - text.length > 1) text += ' ';
    for (let at = 0; at < 4 && text.length < length; at += 1) {
      text += LETTERS[(offset + text.length) % LETTERS.length];
    }
  }
  return text;
}

/** A conforming book whose spells are `length` code points long, distinct in text, name and translation. */
function book(length = 27): Spell[] {
  return Array.from({ length: SPELL_BOOK_SIZE }, (_, index) => ({
    name: `${NAME_BASES[index % NAME_BASES.length]} ${LETTERS[index % LETTERS.length].toUpperCase()}`,
    text: wordRun(length, index),
    translation: `${ZH_BASES[index % ZH_BASES.length]}，第 ${index + 1} 条。`,
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
  it('接受真实模型实际产出的长度：39–50 只是提示，短咒文整本书照常通过', () => {
    // Short model sentences and the length target must both remain playable.
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

  it('模型输出的首尾空白被规整而不是拒绝，空格与标点原样保留', () => {
    const text = 'Bind the frost, call the moon; "starlight" guard this body!';
    const trimmed = validateSpellSet(
      withFirst({
        text: ` ${text}\n`,
        name: ' Moonward Guard ',
        translation: ' 月光守卫护此身！ ',
      }),
    );
    expect(trimmed.ok).toBe(true);
    if (trimmed.ok) {
      expect(trimmed.spells[0].text).toBe(text);
      expect(trimmed.spells[0].name).toBe('Moonward Guard');
      expect(trimmed.spells[0].translation).toBe('月光守卫护此身！');
    }
  });

  it('缺失或空白的中文翻译都进不了咒书', () => {
    expect(rejection(withFirst({ translation: undefined }))).toBe('translation');
    expect(rejection(withFirst({ translation: '' }))).toBe('translation-empty');
    expect(rejection(withFirst({ translation: '   ' }))).toBe('translation-empty');
  });

  it('翻译必须是真实中文：英文原文或拼音式占位都被拒绝', () => {
    expect(rejection(withFirst({ translation: 'Bind the frost, call the moon!' }))).toBe(
      'translation-chars',
    );
    expect(rejection(withFirst({ translation: 'yue guang shou wei hu ci shen!' }))).toBe(
      'translation-chars',
    );
    expect(rejection(withFirst({ translation: '！！！' }))).toBe('translation-chars');
  });

  it('翻译是元数据：超长被截停，重复却无妨，也不受 ASCII 约束', () => {
    expect(rejection(withFirst({ translation: '烬'.repeat(65) }))).toBe('translation-length:65');
    // Only the typed English texts must be unique; translations may repeat freely.
    const repeated = book();
    repeated[1] = { ...repeated[1], translation: repeated[0].translation };
    expect(rejection({ spells: repeated })).toBeNull();
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

  it('中文、全角标点与控制字符都进不了新生成的咒书', () => {
    expect(rejection(withFirst({ text: `${wordRun(20, 0)}咒` }))).toBe('text-chars');
    expect(rejection(withFirst({ text: `${wordRun(20, 0)}！` }))).toBe('text-chars');
    expect(rejection(withFirst({ text: `“${wordRun(18, 0)}”` }))).toBe('text-chars');
    expect(rejection(withFirst({ text: `${wordRun(9, 0)}\n${wordRun(9, 3)}` }))).toBe('text-chars');
    expect(rejection(withFirst({ text: `${wordRun(20, 0)}🌸` }))).toBe('text-chars');
    expect(rejection(withFirst({ name: 'Ember咒' }))).toBe('name-chars');
  });

  it('咒文名称与文本长度按码点计数，名称 2 到 24 个字符', () => {
    // 13 emoji are 13 code points (26 UTF-16 units): passing the length gate proves code-point counting.
    expect(rejection(withFirst({ name: '🌸'.repeat(13) }))).toBe('name-chars');
    expect(rejection(withFirst({ name: 'E' }))).toBe('name-length:1');
    expect(rejection(withFirst({ name: wordRun(25, 0) }))).toBe('name-length:25');
    expect(rejection(withFirst({ name: 'Hex of the Hollow Moon' }))).toBeNull();
  });

  it('元素枚举与字段形状都被校验', () => {
    expect(rejection(withFirst({ element: 'light' }))).toBe('element');
    expect(rejection(withFirst({ text: undefined }))).toBe('types');
    expect(rejection({ spells: ['not-a-spell', ...book(20).slice(1)] })).toBe('entry');
  });

  it('结尾风格只是提示不是校验：! 与 ~ 结尾的咒文和名称都通过', () => {
    expect(rejection(withFirst({ text: `${wordRun(19, 0)}!` }))).toBeNull();
    expect(rejection(withFirst({ text: `${wordRun(19, 1)}~` }))).toBeNull();
    expect(rejection(withFirst({ name: "Storm's Wrath!" }))).toBeNull();
    expect(rejection(withFirst({ name: 'Ember Bolt ~' }))).toBeNull();
  });
});
