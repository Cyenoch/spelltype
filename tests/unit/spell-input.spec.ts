import { describe, expect, it } from 'bun:test';
import { normalizeSpellInput } from '../../shared/spell-input';

describe('spell punctuation correction', () => {
  it('uses the target punctuation without changing letters, case or spacing', () => {
    const target = 'Rise, "moon"! Flow~';
    expect(normalizeSpellInput('Rise， “moon”！ Flow～', target)).toBe(target);
    const wrong = 'rise; "moon"?Flow~';
    expect(normalizeSpellInput(wrong, target)).toBe(wrong);
    expect(normalizeSpellInput('Ｒise, "moon"! Flow~', target)).toBe('Ｒise, "moon"! Flow~');
  });

  it('accepts halfwidth punctuation for an existing Chinese target without deleting extra input', () => {
    expect(normalizeSpellInput('星光,听我召唤!~!', '星光，听我召唤！～')).toBe(
      '星光，听我召唤！～!',
    );
    expect(normalizeSpellInput('Glow!', 'Glow!')).toBe('Glow!');
  });

  it('aligns punctuation by code point even when an incorrect character is a surrogate pair', () => {
    expect(normalizeSpellInput('🔥！', 'A!')).toBe('🔥!');
    expect(normalizeSpellInput('A！', '🔥!')).toBe('A!');
    expect(normalizeSpellInput('🔥x！', 'A!')).toBe('🔥x！');
  });
});
