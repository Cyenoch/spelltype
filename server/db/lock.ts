import { mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Exclusive ownership of a PGlite data directory.
 *
 * PGlite has no server process and no cross-process locking of its own: two instances opening the
 * same directory corrupt each other's files. Before constructing PGlite, the opener claims a lock
 * file next to (never inside — a stray file can break PGlite's data-directory probe) the directory
 * with an atomic `O_CREAT | O_EXCL` create. The claim is conservative by design:
 *
 * - The directory is canonicalized with `realpath` *before* the lock path is derived, so symlink
 *   aliases of one real directory collapse onto one lock file and the opened engine always
 *   receives exactly the claimed canonical directory.
 * - The lock lives for the whole life of the opened database and is removed only by a clean close.
 * - A second opener — including one in the same process — fails immediately; nothing waits, and
 *   nothing steals the lock after a timeout.
 * - A lock left behind by a crashed process also fails the next open, with the recorded receipt in
 *   the message so an operator can confirm the owner is gone and remove the file by hand. This
 *   code never takes over a lock automatically: guessing liveness wrong means two owners.
 */

export class DirectoryLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryLockError';
  }
}

export interface DirectoryClaim {
  /** Where the lock file lives, for diagnostics. */
  readonly path: string;
  /**
   * The canonical claimed directory (`realpath` of the request). Pass exactly this to PGlite so
   * the locked directory and the used directory can never diverge through aliases.
   */
  readonly directory: string;
  /** Removes the lock file. Idempotent; the second call is a no-op. */
  release(): Promise<void>;
}

const LOCK_SUFFIX = '.spelltype-db.lock';

interface LockReceipt {
  pid: number;
  hostname: string;
  createdAt: string;
}

/**
 * Claims `dataDir` for exclusive use, creating the directory if needed. Resolves only when this
 * process — and this call — owns the directory; rejects with {@link DirectoryLockError} otherwise.
 */
export async function claimDataDirectory(dataDir: string): Promise<DirectoryClaim> {
  const requested = path.resolve(dataDir);
  await mkdir(requested, { recursive: true });
  // Lexical resolution cannot see aliases: `/tmp/a` and `/data/pg` can be the same directory
  // through a symlink, and two lexical lock paths would allow two owners. Canonicalize first.
  const directory = await realpath(requested);
  const lockPath = path.join(path.dirname(directory), `${path.basename(directory)}${LOCK_SUFFIX}`);

  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new DirectoryLockError(await refusalMessage(lockPath, directory));
    }
    throw error;
  }

  const receipt: LockReceipt = {
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  };
  try {
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  } finally {
    await handle.close();
  }

  let released = false;
  return {
    path: lockPath,
    directory,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      try {
        await unlink(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      }
    },
  };
}

/**
 * Builds the fail-closed message for an already-claimed directory. The receipt's `pid` is probed
 * purely to tell the operator whether the owner still exists — the answer never gates behavior:
 * every EEXIST ends in a refusal.
 */
async function refusalMessage(lockPath: string, directory: string): Promise<string> {
  let owner = 'an unreadable receipt';
  try {
    const raw = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<LockReceipt>;
    if (typeof raw.pid === 'number') {
      let alive: boolean;
      try {
        process.kill(raw.pid, 0);
        alive = true;
      } catch (probe) {
        alive = (probe as NodeJS.ErrnoException)?.code === 'EPERM';
      }
      const host = raw.hostname ? ` on ${raw.hostname}` : '';
      const since = raw.createdAt ? ` since ${raw.createdAt}` : '';
      owner = `pid ${raw.pid}${host}${since} (${alive ? 'still running' : 'no longer running'})`;
    }
  } catch {
    // Fall through with the generic owner description.
  }
  return (
    `PGlite data directory ${directory} is already claimed by ${owner}; refusing to open a second owner. ` +
    `If no live process owns it (for example after a crash), remove ${lockPath} manually. ` +
    `This process never steals, expires or replaces an existing claim.`
  );
}
