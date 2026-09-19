import { mkdir, open, readFile, realpath, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * PGlite 数据目录的排他所有权管理。
 *
 * PGlite 自身没有后台服务进程，也不具备跨进程锁定机制：若两个实例同时打开同一个目录，
 * 将导致彼此的文件损坏。在构造 PGlite 实例之前，打开方会使用原子的 `O_CREAT | O_EXCL` 模式
 * 在该目录同级（绝不能放在内部——遗留的无关文件会破坏 PGlite 对数据目录的探测判断）
 * 创建一个锁文件来声明占有权。该机制的设计特意偏向审慎保守：
 *
 * - 在推导锁文件路径*之前*，先使用 `realpath` 对目录进行规范化，确保同一真实目录的软链接别名
 *   均收敛到同一个锁文件上，从而保证打开的数据库引擎接收到的始终是已被占有的规范目录。
 * - 锁文件贯穿已打开数据库的整个生命周期，且仅在正常干净关闭时才会被移除。
 * - 第二个打开者——即便位于同一进程内——也会立即失败；不进行任何等待，也不会在超时后抢占锁。
 * - 进程崩溃留下的锁同样会导致下一次打开失败，并在报错信息中输出记录的凭据，
 *   以便运维人员确认原属主进程已不存在后手动删除该文件。本代码绝不会自动接管残留锁：对存活性误判意味着出现两个所有者。
 */

export class DirectoryLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectoryLockError';
  }
}

export interface DirectoryClaim {
  /** 锁文件的存放路径，用于诊断排查。 */
  readonly path: string;
  /**
   * 经规范化的已占有目录（请求路径的 `realpath` 解析结果）。必须将此路径准确传给 PGlite，
   * 确保被锁定的目录与实际使用的目录绝不会因软链接别名产生分歧。
   */
  readonly directory: string;
  /** 移除锁文件。具有幂等性；重复调用为无操作。 */
  release(): Promise<void>;
}

const LOCK_SUFFIX = '.spelltype-db.lock';

interface LockReceipt {
  pid: number;
  hostname: string;
  createdAt: string;
}

/**
 * 申领 `dataDir` 的排他使用权，如有必要将创建该目录。仅当当前进程——以及当前调用——
 * 确实拥有该目录时才会成功完成；否则将以 {@link DirectoryLockError} 拒绝。
 */
export async function claimDataDirectory(dataDir: string): Promise<DirectoryClaim> {
  const requested = path.resolve(dataDir);
  await mkdir(requested, { recursive: true });
  // 纯文本词法解析无法识别别名软链接：`/tmp/a` 和 `/data/pg` 可能通过符号链接指向同一目录，
  // 若生成两条词法锁路径将导致出现两个所有者。因此必须先进行规范化。
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
 * 为已被占有的目录构造故障阻断的错误提示信息。探测凭据中的 `pid` 仅用于向运维人员
 * 提示属主进程是否仍存在——该判定绝不影响运行行为：遇到 EEXIST 一律予以拒绝。
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
    // 若解析凭据失败，降级采用通用的属主描述信息。
  }
  return (
    `PGlite data directory ${directory} is already claimed by ${owner}; refusing to open a second owner. ` +
    `If no live process owns it (for example after a crash), remove ${lockPath} manually. ` +
    `This process never steals, expires or replaces an existing claim.`
  );
}
