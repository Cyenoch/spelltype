/**
 * Generation attempt policy — the part of the AI path that decides how often a match is billed and
 * which failure the player sees.
 *
 * This replaced the browser-driven failure scenarios: the room's own validation is unit-tested in
 * `generation-schema.spec.ts`, and here the model call itself is stubbed so the *policy* is
 * observable — how many calls a candidate costs, what the retry carries, and which categories are
 * never retried automatically.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SPELL_BOOK_SIZE, type Spell } from '../../shared/protocol';
import type { Env } from '../../worker/env';

// `vi.hoisted` keeps the stubs reachable from hoisted `vi.mock` factories.
const stubs = vi.hoisted(() => {
  class MissingDeepSeekKeyError extends Error {
    constructor() {
      super('deepseek:missing_api_key');
      this.name = 'MissingDeepSeekKeyError';
    }
  }
  return { generateText: vi.fn(), MissingDeepSeekKeyError };
});
const generateText = stubs.generateText;

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: stubs.generateText };
});

vi.mock('../../worker/generation/provider', () => ({
  MissingDeepSeekKeyError: stubs.MissingDeepSeekKeyError,
  createSpellModel: (env: { DEEPSEEK_API_KEY?: string }) => {
    if (!env.DEEPSEEK_API_KEY) throw new stubs.MissingDeepSeekKeyError();
    return { provider: 'stub' };
  },
}));

// `vi.mock` is hoisted above this import, so the module under test gets the stubs.
import { GENERATION_ATTEMPTS, generateSpellSet } from '../../worker/generation/spells';

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

/** An exact-`length` code point run of ASCII pseudo-words whose first letter is fixed by `offset`. */
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

// The theme is player data, not generation output: a Chinese theme must flow through the English
// prompt untouched. There is no difficulty anymore — one hard generation contract for every room.
const input = { theme: '咒文契约', variation: 'v1' };
/** Only the key matters to the stubbed provider; the rest of the binding surface is irrelevant here. */
const env = { DEEPSEEK_API_KEY: 'test-key' } as unknown as Env;
const keylessEnv = {} as unknown as Env;

/** The prompt of the `call`-th model request. */
function promptOf(call: number): string {
  const args = generateText.mock.calls[call][0];
  return args.prompt;
}

beforeEach(() => {
  generateText.mockReset();
});

describe('生成尝试策略', () => {
  it('结构不合规的输出重试一次并带上拒绝原因，仍不合规则如实失败，不会再有第三次调用', async () => {
    generateText.mockResolvedValueOnce({ output: { spells: book().slice(0, 1) } });
    generateText.mockResolvedValueOnce({ output: { spells: book() } });
    const recovered = await generateSpellSet(env, input);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.attempts).toBe(2);
    expect(generateText).toHaveBeenCalledTimes(2);
    // The retry carries the concrete reason the first candidate was refused, not a fixed notice.
    expect(promptOf(0)).not.toContain('previous attempt was rejected');
    expect(promptOf(1)).toContain('The previous attempt was rejected (count)');

    generateText.mockReset();
    generateText.mockResolvedValue({ output: { spells: book().slice(0, 1) } });
    expect(await generateSpellSet(env, input)).toEqual({
      ok: false,
      reason: 'invalid',
      message: expect.any(String),
    });
    expect(generateText).toHaveBeenCalledTimes(GENERATION_ATTEMPTS);

    // A conforming first attempt is not re-billed.
    generateText.mockReset();
    generateText.mockResolvedValueOnce({ output: { spells: book() } });
    expect(await generateSpellSet(env, input)).toMatchObject({ ok: true, attempts: 1 });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('真实模型典型短咒文整本直接通过，不触发重试或失败提示', async () => {
    // The user-reported bug: on the real endpoint the model writes whole books of ~14-24 char
    // sentences; the old per-difficulty bands rejected them and players saw 「AI 返回的咒文不
    // 符合要求」 almost every match. The single 39-50 target is prompt guidance only, so the same
    // book must start the match on the first call.
    generateText.mockResolvedValueOnce({ output: { spells: book(16) } });
    const outcome = await generateSpellSet(env, input);
    expect(outcome).toMatchObject({ ok: true, attempts: 1 });
    expect(generateText).toHaveBeenCalledTimes(1);
    // Every prompt carries the one hard length target, and no difficulty line exists anymore.
    expect(promptOf(0)).toContain('targets 39 to 50 characters');
    expect(promptOf(0)).not.toContain('Difficulty:');
  });

  it('供应商故障与超时不重试，只花一次调用', async () => {
    generateText.mockRejectedValueOnce(new Error('upstream exploded'));
    expect(await generateSpellSet(env, input)).toMatchObject({ ok: false, reason: 'upstream' });
    expect(generateText).toHaveBeenCalledTimes(1);

    generateText.mockReset();
    const timeout = new Error('aborted');
    timeout.name = 'TimeoutError';
    generateText.mockRejectedValueOnce(timeout);
    expect(await generateSpellSet(env, input)).toMatchObject({ ok: false, reason: 'timeout' });
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('未配置密钥时不发起任何模型调用', async () => {
    expect(await generateSpellSet(keylessEnv, input)).toMatchObject({
      ok: false,
      reason: 'unconfigured',
    });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('失败信息不泄露供应商细节', async () => {
    generateText.mockRejectedValueOnce(new Error('{"apiKey":"sk-secret"}'));
    const failure = await generateSpellSet(env, input);
    if (failure.ok) throw new Error('expected a failure');
    expect(failure.message).not.toContain('sk-secret');
  });
});
