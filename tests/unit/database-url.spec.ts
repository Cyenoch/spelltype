/**
 * 数据库 URL 语法规则 —— 配置与底层存储之间的边界。
 *
 * `parseDatabaseUrl` 是 DATABASE_URL 的统一解析器，供服务器、Drizzle CLI 配置和测试共用。
 * 此处固化的关键行为包括：正确接受三种 pglite 格式以及两种 postgres 协议，并保持有效载荷完整；
 * 任何格式错误（如空字符串、仅有 `pglite://` 前缀、主机名风格的 pglite 路径、带 query 的 pglite URL、非数据库协议）
 * 均会被拒绝并抛出 `DatabaseUrlError`。设计上特意不设降级容错机制：代码无法理解的 URL 必须阻止启动，
 * 绝不能背着运维人员默默回退到内存数据库。错误信息中绝不会回显 URL 原文，因为 postgres 连接串中包含凭据信息。
 */
import { describe, expect, it } from 'bun:test';
import { DatabaseUrlError, parseDatabaseUrl } from '../../server/db/url';

describe('parseDatabaseUrl', () => {
  it('正确解析三种 pglite 格式', () => {
    expect(parseDatabaseUrl('pglite://./.data/spelltype')).toEqual({
      driver: 'pglite',
      dataDir: './.data/spelltype',
    });
    expect(parseDatabaseUrl('pglite:///var/lib/spelltype/pglite')).toEqual({
      driver: 'pglite',
      dataDir: '/var/lib/spelltype/pglite',
    });
    expect(parseDatabaseUrl('pglite://:memory:')).toEqual({ driver: 'pglite-memory' });
  });

  it('正确解析两种 postgres 协议且不改写连接串内容', () => {
    const withCredentials = 'postgres://user:secret@db.internal:5432/spelltype?sslmode=require';
    expect(parseDatabaseUrl(withCredentials)).toEqual({
      driver: 'postgres',
      connectionString: withCredentials,
    });
    const altScheme = 'postgresql://127.0.0.1:5433/spelltype';
    expect(parseDatabaseUrl(altScheme)).toEqual({
      driver: 'postgres',
      connectionString: altScheme,
    });
  });

  it('允许 URL 首尾存在空白字符，但拒绝其他任何格式异常', () => {
    expect(parseDatabaseUrl('  pglite://:memory:\n')).toEqual({ driver: 'pglite-memory' });
  });

  it.each([
    ['空字符串', ''],
    ['纯空白字符串', '   '],
    ['仅包含 pglite 前缀', 'pglite://'],
    ['主机名风格的 pglite 路径', 'pglite://pgdata.internal/spelltype'],
    ['带 query 参数的 pglite URL', 'pglite://./data?cache=1'],
    ['带 fragment 的 pglite URL', 'pglite:///data#frag'],
    ['在 :memory: 后带额外路径段的 pglite URL', 'pglite://:memory:/extra'],
    ['未以 ./ 开头的相对路径', 'pglite://data/spelltype'],
    ['mysql URL', 'mysql://localhost/spelltype'],
    ['sqlite URL', 'sqlite://./local.db'],
    ['纯主机名和端口', 'db.internal:5432'],
    ['乱码无效字符', 'not a url'],
  ])('拒绝 %s', (_label, url) => {
    expect(() => parseDatabaseUrl(url)).toThrow(DatabaseUrlError);
  });

  it('拒绝非字符串输入而不是隐式强制转换', () => {
    expect(() => parseDatabaseUrl(undefined as unknown as string)).toThrow(DatabaseUrlError);
  });

  it('绝不回显被拒绝的 URL，防止泄露 postgres URL 中携带的凭据', () => {
    let message = '';
    try {
      parseDatabaseUrl('xpostgres://user:super-secret@db.internal:5432/spelltype');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('super-secret');
    expect(message).not.toContain('db.internal');
  });
});
