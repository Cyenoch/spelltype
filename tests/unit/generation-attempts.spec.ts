import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import { SPELL_BOOK_SIZE, type Spell } from '../../shared/protocol';
import { createSpellModel } from '../../server/generation/provider';
import { GENERATION_ATTEMPTS, generateSpellSet } from '../../server/generation/spells';

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

function book(length = 27): Spell[] {
  return Array.from({ length: SPELL_BOOK_SIZE }, (_, index) => ({
    name: `${NAME_BASES[index % NAME_BASES.length]} ${LETTERS[index % LETTERS.length].toUpperCase()}`,
    text: wordRun(length, index),
    translation: `${ZH_BASES[index % ZH_BASES.length]}，第 ${index + 1} 条。`,
    element: (['arcane', 'fire', 'ice', 'storm'] as const)[index % 4],
  }));
}

function response(spells: Spell[]) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ spells }) }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}

const providerCall = mock(async () => response(book()));
const modelFactory = () => new MockLanguageModelV4({ doGenerate: providerCall });
const input = { theme: '咒文契约', variation: 'v1' };

beforeEach(() => {
  providerCall.mockReset();
  providerCall.mockImplementation(async () => response(book()));
});

describe('生成尝试策略', () => {
  it('结构不合规的输出仅重试一次，成功后不再计费调用', async () => {
    providerCall.mockResolvedValueOnce(response(book().slice(0, 1)));
    expect(await generateSpellSet(modelFactory, input)).toMatchObject({ ok: true, attempts: 2 });
    expect(providerCall).toHaveBeenCalledTimes(2);
  });

  it('持续不合规的输出如实失败，不会发起第三次调用', async () => {
    providerCall.mockResolvedValue(response(book().slice(0, 1)));
    expect(await generateSpellSet(modelFactory, input)).toMatchObject({
      ok: false,
      reason: 'invalid',
    });
    expect(providerCall).toHaveBeenCalledTimes(GENERATION_ATTEMPTS);
  });

  it('典型短咒文整本直接通过，不把提示长度当作拒绝条件', async () => {
    providerCall.mockResolvedValue(response(book(16)));
    expect(await generateSpellSet(modelFactory, input)).toMatchObject({ ok: true, attempts: 1 });
    expect(providerCall).toHaveBeenCalledTimes(1);
  });

  it('供应商故障不自动重试', async () => {
    providerCall.mockRejectedValue(new Error('upstream exploded'));
    expect(await generateSpellSet(modelFactory, input)).toMatchObject({
      ok: false,
      reason: 'upstream',
    });
    expect(providerCall).toHaveBeenCalledTimes(1);
  });

  it('超时不自动重试', async () => {
    const timeout = new Error('aborted');
    timeout.name = 'TimeoutError';
    providerCall.mockRejectedValue(timeout);
    expect(await generateSpellSet(modelFactory, input)).toMatchObject({
      ok: false,
      reason: 'timeout',
    });
    expect(providerCall).toHaveBeenCalledTimes(1);
  });

  it('未配置密钥时不发起模型调用', async () => {
    const keyless = () => createSpellModel({ apiKey: null, model: 'deepseek-flash' });
    expect(await generateSpellSet(keyless, input)).toMatchObject({
      ok: false,
      reason: 'unconfigured',
    });
    expect(providerCall).not.toHaveBeenCalled();
  });

  it('失败信息不泄露供应商细节', async () => {
    providerCall.mockRejectedValue(new Error('{"apiKey":"sk-secret"}'));
    const failure = await generateSpellSet(modelFactory, input);
    if (failure.ok) throw new Error('expected a failure');
    expect(failure.message).not.toContain('sk-secret');
  });
});
