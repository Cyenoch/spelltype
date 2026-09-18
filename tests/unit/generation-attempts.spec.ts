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

const HAN = '霜月幽炎雷渊灵焰寒星冥绮岚晞辰暮曦云雾雨雪风花叶露金木水火土山河海川岩石';
const NAMES = ['炎爆术', '霜缚咒', '雷引诀', '幽影环', '星辉印', '冰封界', '风吟诀', '月蚀咒'];

function hanRun(length: number, offset: number): string {
  let text = '';
  while (text.length < length) text += HAN[(offset + text.length) % HAN.length];
  return text;
}

/** A conforming book whose spells are `length` characters long, distinct in text and name. */
function book(length = 27): Spell[] {
  return Array.from({ length: SPELL_BOOK_SIZE }, (_, index) => ({
    name: `${NAMES[index % NAMES.length]}${HAN[index % HAN.length]}`,
    text: hanRun(length, index),
    element: (['arcane', 'fire', 'ice', 'storm'] as const)[index % 4],
  }));
}

const input = { theme: '咒文契约', difficulty: 'normal' as const, variation: 'v1' };
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
    expect(promptOf(0)).not.toContain('上一次生成不符合要求');
    expect(promptOf(1)).toContain('上一次生成不符合要求（count）');

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
