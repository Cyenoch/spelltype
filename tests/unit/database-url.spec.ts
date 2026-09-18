/**
 * Database URL grammar — the boundary between configuration and storage.
 *
 * `parseDatabaseUrl` is the one interpreter of DATABASE_URL, shared by the server, the Drizzle CLI
 * config and the tests. Pinned here: the three pglite forms and the two postgres schemes are
 * accepted with their payload intact; anything malformed — an empty string, a bare `pglite://`,
 * a host-style pglite path, a query on a pglite URL, a non-database scheme — is rejected as a
 * `DatabaseUrlError`. There is deliberately no fallback: a URL the code does not understand must
 * stop startup, never open an in-memory database behind the operator's back. Error messages never
 * echo the URL, because postgres connection strings carry credentials.
 */
import { describe, expect, it } from 'bun:test';
import { DatabaseUrlError, parseDatabaseUrl } from '../../server/db/url';

describe('parseDatabaseUrl', () => {
  it('parses the three pglite forms', () => {
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

  it('parses both postgres schemes without rewriting the string', () => {
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

  it('accepts surrounding whitespace but nothing else about the URL', () => {
    expect(parseDatabaseUrl('  pglite://:memory:\n')).toEqual({ driver: 'pglite-memory' });
  });

  it.each([
    ['the empty string', ''],
    ['a whitespace-only string', '   '],
    ['a bare pglite prefix', 'pglite://'],
    ['a host-style pglite path', 'pglite://pgdata.internal/spelltype'],
    ['a pglite URL with a query', 'pglite://./data?cache=1'],
    ['a pglite URL with a fragment', 'pglite:///data#frag'],
    ['a pglite URL with extra segments on :memory:', 'pglite://:memory:/extra'],
    ['a relative path without ./', 'pglite://data/spelltype'],
    ['a mysql URL', 'mysql://localhost/spelltype'],
    ['a sqlite URL', 'sqlite://./local.db'],
    ['a bare host', 'db.internal:5432'],
    ['garbage', 'not a url'],
  ])('rejects %s', (_label, url) => {
    expect(() => parseDatabaseUrl(url)).toThrow(DatabaseUrlError);
  });

  it('rejects non-string input instead of coercing it', () => {
    expect(() => parseDatabaseUrl(undefined as unknown as string)).toThrow(DatabaseUrlError);
  });

  it('never echoes a rejected URL, because postgres URLs carry credentials', () => {
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
