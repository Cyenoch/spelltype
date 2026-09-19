import { describe, expect, it } from 'bun:test';
import { normalizeSpellInput } from '../../shared/spell-input';

describe('法术标点符号纠正', () => {
  it('采用目标标点符号且不改变英文字母、大小写或空格', () => {
    const target = 'Rise, "moon"! Flow~';
    expect(normalizeSpellInput('Rise， “moon”！ Flow～', target)).toBe(target);
    const wrong = 'rise; "moon"?Flow~';
    expect(normalizeSpellInput(wrong, target)).toBe(wrong);
    expect(normalizeSpellInput('Ｒise, "moon"! Flow~', target)).toBe('Ｒise, "moon"! Flow~');
  });

  it('允许已有的中文目标接受半角标点输入且不删除多余的输入', () => {
    expect(normalizeSpellInput('星光,听我召唤!~!', '星光，听我召唤！～')).toBe(
      '星光，听我召唤！～!',
    );
    expect(normalizeSpellInput('Glow!', 'Glow!')).toBe('Glow!');
  });

  it('即使用错的字符是代理对（Emoji 等），也能按码点正确对齐标点符号', () => {
    expect(normalizeSpellInput('🔥！', 'A!')).toBe('🔥!');
    expect(normalizeSpellInput('A！', '🔥!')).toBe('A!');
    expect(normalizeSpellInput('🔥x！', 'A!')).toBe('🔥x！');
  });
});
