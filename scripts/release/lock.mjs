// Exclusive host release execution. A single lock file guards every mutating
// release operation; it is never stolen by timeout. A dead holder requires
// the explicit `unlock` command so an operator confirms the original process
// (and everything it spawned) is really gone.

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readHolder(lockFile) {
  try {
    return JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch {
    return null;
  }
}

export function acquireLock(lockFile, command) {
  let fd;
  try {
    fd = openSync(lockFile, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const holder = readHolder(lockFile);
    const pid = holder?.pid;
    if (pid && processAlive(pid)) {
      throw new Error(
        `Release "${holder?.command ?? 'unknown'}" (pid ${pid}, started ${holder?.startedAt ?? '?'}) holds the host lock ${lockFile}. Only one release executor may run at a time.`,
      );
    }
    throw new Error(
      `Stale release lock ${lockFile}${holder ? ` (pid ${pid ?? '?'}, not running)` : ' (unreadable)'}. After confirming no release process is still running or spawning work, remove it with: bun run deploy unlock`,
    );
  }
  try {
    writeSync(
      fd,
      `${JSON.stringify({ pid: process.pid, host: hostname(), startedAt: new Date().toISOString(), command })}\n`,
    );
  } finally {
    closeSync(fd);
  }
  return {
    release() {
      try {
        unlinkSync(lockFile);
      } catch {
        // best effort; a leftover lock on crash is handled by unlock
      }
    },
  };
}

export function clearStaleLock(lockFile) {
  if (!existsSync(lockFile)) throw new Error(`No lock file at ${lockFile}; nothing to unlock.`);
  const holder = readHolder(lockFile);
  const pid = holder?.pid;
  if (pid && processAlive(pid)) {
    throw new Error(
      `Lock holder pid ${pid} is still running. Terminate it first; unlock never removes a live lock.`,
    );
  }
  unlinkSync(lockFile);
  return holder;
}
