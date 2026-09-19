// 宿主机独占部署执行控制。通过单个锁文件保护所有修改状态的部署操作；
// 该锁绝不会因超时而被抢占。若持锁进程异常终止，
// 必须通过显式的 `unlock` 命令解锁，以确保运维人员确认原进程（及其派生的所有子任务）已真正退出。

import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readHolder(
  lockFile: string,
): { pid?: number; command?: string; startedAt?: string } | null {
  try {
    return JSON.parse(readFileSync(lockFile, 'utf8'));
  } catch {
    return null;
  }
}

export function acquireLock(lockFile: string, command: string): { release(): void } {
  let fd: number;
  try {
    fd = openSync(lockFile, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const holder = readHolder(lockFile);
    const pid = holder?.pid;
    if (pid && processAlive(pid)) {
      throw new Error(
        `Deploy "${holder?.command ?? 'unknown'}" (pid ${pid}, started ${holder?.startedAt ?? '?'}) holds the host lock ${lockFile}. Only one deploy executor may run at a time.`,
      );
    }
    throw new Error(
      `Stale deploy lock ${lockFile}${holder ? ` (pid ${pid ?? '?'}, not running)` : ' (unreadable)'}. After confirming no deploy process is still running or spawning work, remove it with: bun run deploy unlock`,
    );
  }
  try {
    writeSync(
      fd,
      `${JSON.stringify({
        pid: process.pid,
        host: hostname(),
        startedAt: new Date().toISOString(),
        command,
      })}\n`,
    );
  } finally {
    closeSync(fd);
  }
  return {
    release() {
      try {
        unlinkSync(lockFile);
      } catch {
        // 尽最大努力清理；进程崩溃导致的锁残留由 unlock 命令处理
      }
    },
  };
}

export function clearStaleLock(lockFile: string): unknown {
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
