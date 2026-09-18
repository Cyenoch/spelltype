/**
 * The open/close lifecycle on real PGlite file databases — where ownership and readiness live.
 *
 * Pinned here are the failure modes a second process (or a second open in the same process) could
 * turn into corruption or silent data forks: opening applies the repo's migrations before the
 * database is usable, a claimed data directory refuses every second opener while the first is
 * alive, symlink aliases of one real directory collapse onto a single claim, a crash-stale lock
 * file refuses the next opener with the recorded receipt instead of being stolen, a failed
 * migration gives the directory back so a fixed retry can claim it, and a clean close is the only
 * thing that releases a claim. In-memory databases exist only when the
 * URL explicitly asks for `:memory:` and start empty every time. The default migrations folder is
 * exercised throughout — tests run from the repository root, exactly like the dev server.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import {
  DatabaseMigrationError,
  DirectoryLockError,
  accounts,
  openDatabase,
  type OpenedDatabase,
} from '../../server/db';

const NOW = 1_700_000_000_000;
const TIMEOUT = 120_000;
// Every test here boots a real WASM Postgres; the runner's 5s default is not enough.
setDefaultTimeout(TIMEOUT);

const cleanupPaths: string[] = [];
const opened: OpenedDatabase[] = [];

afterEach(async () => {
  for (const db of opened.splice(0)) {
    await db.close().catch(() => {});
  }
  await Promise.all(
    cleanupPaths.splice(0).map((p) => rm(p, { recursive: true, force: true }).catch(() => {})),
  );
});

/** A throwaway PGlite data directory plus its sibling lock file, both removed on cleanup. */
async function tempDataDir(): Promise<{ dir: string; url: string; lockPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'spelltype-pglite-'));
  const lockPath = path.join(path.dirname(dir), `${path.basename(dir)}.spelltype-db.lock`);
  cleanupPaths.push(dir, lockPath);
  return { dir, url: `pglite://${dir}`, lockPath };
}

async function insertAccount(db: OpenedDatabase['db'], id: string): Promise<void> {
  await db.insert(accounts).values({
    id,
    username: `user-${id}`,
    username_key: `user-${id}`,
    password_hash: 'hash',
    created_at: NOW,
  });
}

describe('openDatabase on pglite file directories', () => {
  it('migrates before use, persists across close and reopens idempotently', async () => {
    const { url } = await tempDataDir();
    const first = await openDatabase(url);
    opened.push(first);
    await insertAccount(first.db, 'account-1');
    await first.close();

    // The second open runs the same migrations again over an already-migrated database; the
    // journal must make that a no-op instead of a duplicate-DDL failure.
    const second = await openDatabase(url);
    opened.push(second);
    const rows = await second.db.select().from(accounts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.created_at).toBe(NOW);
    expect(typeof rows[0]?.created_at).toBe('number');
    await second.close();
  });

  it('refuses a second owner until the first closes, then hands the directory over', async () => {
    const { url } = await tempDataDir();
    const first = await openDatabase(url);
    opened.push(first);

    let failure: unknown;
    try {
      await openDatabase(url);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DirectoryLockError);
    expect((failure as Error).message).toContain('already claimed');
    expect((failure as Error).message).toContain(`pid ${process.pid}`);
    expect((failure as Error).message).toContain('never steals');

    await first.close();
    const reopened = await openDatabase(url);
    opened.push(reopened);
    expect(await reopened.db.select().from(accounts)).toEqual([]);
    await reopened.close();
  });

  it('collapses symlink aliases onto one claim so one real directory cannot get two owners', async () => {
    const real = await mkdtemp(path.join(tmpdir(), 'spelltype-pglite-real-'));
    const alias = `${real}-alias`;
    await symlink(real, alias);
    cleanupPaths.push(real, alias);

    // Opening through the alias claims the canonicalized directory; the same directory reached
    // under its real name must therefore be refused, not granted a second lexical lock path.
    const first = await openDatabase(`pglite://${alias}`);
    opened.push(first);

    let failure: unknown;
    try {
      await openDatabase(`pglite://${real}`);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DirectoryLockError);
    expect((failure as Error).message).toContain(`pid ${process.pid}`);

    await first.close();
    // Once the (single) claim is released, the directory is free under any name.
    const second = await openDatabase(`pglite://${real}`);
    opened.push(second);
    await second.close();
  });

  it('fails closed on a crash-stale lock and never takes it over automatically', async () => {
    const { dir, url, lockPath } = await tempDataDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 2 ** 28, hostname: 'crashed-host', createdAt: '2026-01-01T00:00:00.000Z' }, null, 2)}\n`,
    );

    let failure: unknown;
    try {
      await openDatabase(url);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DirectoryLockError);
    const message = (failure as Error).message;
    expect(message).toContain('pid 268435456');
    expect(message).toContain('no longer running');
    // The refusal names the lock file as the claimer derives it: canonical (realpath) form.
    const canonicalDir = await realpath(dir);
    const canonicalLock = path.join(
      path.dirname(canonicalDir),
      `${path.basename(canonicalDir)}.spelltype-db.lock`,
    );
    expect(message).toContain(canonicalLock);
    expect(message).toContain('never steals');
    // The refusal left the claim exactly as it was: the operator, not this code, decides.
    await rm(canonicalLock);
  });

  it('releases the claim when migrations fail, so a fixed retry can claim the directory', async () => {
    const { url } = await tempDataDir();
    const broken = await mkdtemp(path.join(tmpdir(), 'spelltype-migrations-'));
    cleanupPaths.push(broken);
    await mkdir(path.join(broken, 'meta'), { recursive: true });
    await writeFile(
      path.join(broken, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [{ idx: 0, version: '0', when: 1, tag: '0000_broken', breakpoints: true }],
      }),
    );
    await writeFile(path.join(broken, '0000_broken.sql'), 'CREATE TABLE definitely_broken(;');

    const failure = await openDatabase(url, { migrationsFolder: broken }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    // The claim was released despite the failure: opening with the real migrations now succeeds.
    const retry = await openDatabase(url);
    opened.push(retry);
    expect(await retry.db.select().from(accounts)).toEqual([]);
    await retry.close();
  });
});

describe('openDatabase in-memory', () => {
  it('only opens a throwaway database when the URL explicitly asks for :memory:', async () => {
    const first = await openDatabase('pglite://:memory:');
    opened.push(first);
    await insertAccount(first.db, 'memory-1');
    await first.close();

    const second = await openDatabase('pglite://:memory:');
    opened.push(second);
    expect(await second.db.select().from(accounts)).toEqual([]);
    await second.close();
  });
});

describe('openDatabase fail-closed guards', () => {
  it('rejects a missing migrations folder before opening any driver', async () => {
    const missing = path.join(tmpdir(), 'definitely-missing-drizzle-folder');
    // The folder guard precedes network IO, including for PostgreSQL.
    for (const url of ['pglite://:memory:', 'postgres://127.0.0.1:1/spelltype']) {
      const failure = await openDatabase(url, { migrationsFolder: missing }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DatabaseMigrationError);
    }
  });
});
