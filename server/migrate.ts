// 生产环境单次数据库 Schema 迁移入口（作为 dist/server/migrate.js 打包进镜像）。
// 仅在旧版本应用已完成停机并停止运行后执行。
// 它会执行前向迁移，随后确保持久化进入 draining 维护状态，并关闭数据库连接。
// 数据转换属于迁移脚本的职责；数据库备份与兼容性评估仍由运维人员负责。
// 此入口绝不获取运行时所有权，也绝不重新开放准入。应用启动也会自动迁移，但不会主动切换维护状态。
//
// 模式：
//   （默认）   执行迁移，确保处于 draining 维护状态，关闭退出。
//   --check    可执行性检查：以 JSON 格式打印入口/构建标识，不操作数据库直接退出。
//              供 scripts/deploy.ts 使用，在正式进入维护前验证候选镜像能够正常运行。

import { openDatabase } from './db';
import { readDatabaseUrl } from './config';
import { enterMaintenance, MaintenanceConflict, readMaintenance } from './maintenance/control';

declare const __SPELLTYPE_BUILD_ID__: string;

const log = console.error;

function buildId(): string {
  return typeof __SPELLTYPE_BUILD_ID__ === 'undefined' ? 'development' : __SPELLTYPE_BUILD_ID__;
}

async function main(): Promise<number> {
  const flags = process.argv.slice(2);
  const hasCheck = flags.includes('--check');
  if (flags.some((flag) => flag !== '--check')) {
    log('usage: bun server/migrate.ts [--check]');
    return 2;
  }
  if (hasCheck) {
    console.log(JSON.stringify({ entry: 'migrate', buildId: buildId() }));
    return 0;
  }

  const url = await readDatabaseUrl();
  const opened = await openDatabase(url);
  try {
    log('applying forward migrations');
    const current = await readMaintenance(opened.db);
    if (current.mode === 'draining') {
      // 若部署流程此前已通过 maintenance 入口完成了停机排水并运行至此处：
      // 绝不重复进入维护状态，也绝不重新开放——这正是核心原则。
      log(`maintenance already draining (revision ${current.revision}); migrations applied`);
      return 0;
    }
    try {
      const entered = await enterMaintenance(opened.db, current.revision);
      log(`maintenance draining (revision ${entered.revision}); migrations applied`);
    } catch (error) {
      if (error instanceof MaintenanceConflict) {
        log(
          'maintenance changed concurrently (CAS conflict); another operator moved the control row — re-read status and retry deliberately',
        );
        return 1;
      }
      throw error;
    }
    return 0;
  } finally {
    await opened.close();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    log(`migrate failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
