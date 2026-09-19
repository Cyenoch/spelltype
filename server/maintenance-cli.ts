// 宿主机端部署运行器的单次维护入口（作为 dist/server/maintenance.js 打包进镜像）。
// 用于检查持久化的维护状态、关闭准入（清空等待中的票据），或通过 revision/epoch 的 CAS 操作重新开放。
// 它不执行任何迁移、不获取运行时所有权，也绝不强制终止进行中的比赛。
// 宿主机部署器会在应用容器内，或故障恢复期间在同镜像的单次容器内调用它。
// 宿主机的 Docker 权限即为此入口的鉴权；它不使用 /api/ops/maintenance 所支持的独立维护专用 Bearer 凭证。
//
// 模式（每次调用必须且只能指定一种）：
//   --status                       以 JSON 格式打印 DrainStatus（只读）
//   --drain --expected-revision N  执行 enterMaintenance CAS；打印 MaintenanceInfo JSON
//   --resume --expected-revision N --expected-runtime-epoch E
//                                  执行 leaveMaintenance CAS；运行器在此之前必须已经
//                                  通过公开的 /health 验证了 E（运行时租约生效中）
//   --check                        以 JSON 格式打印入口/构建标识，不操作数据库直接退出

import { z } from 'zod';
import { openDatabase } from './db';
import { readDatabaseUrl } from './config';
import {
  enterMaintenance,
  inspectMaintenance,
  leaveMaintenance,
  MaintenanceConflict,
} from './maintenance/control';

declare const __SPELLTYPE_BUILD_ID__: string;

const log = console.error;

const revisionSchema = z.coerce.number().int();

function buildId(): string {
  return typeof __SPELLTYPE_BUILD_ID__ === 'undefined' ? 'development' : __SPELLTYPE_BUILD_ID__;
}

function parseRevisions(argv: string[]): {
  expectedRevision?: number;
  expectedRuntimeEpoch?: number;
} {
  let expectedRevision: number | undefined;
  let expectedRuntimeEpoch: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--expected-revision' && value !== undefined) {
      expectedRevision = revisionSchema.parse(value);
      i++;
    } else if (flag === '--expected-runtime-epoch' && value !== undefined) {
      expectedRuntimeEpoch = revisionSchema.parse(value);
      i++;
    } else {
      throw new Error(`unknown or incomplete option ${flag}`);
    }
  }
  return { expectedRevision, expectedRuntimeEpoch };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const actions = ['--status', '--drain', '--resume', '--check'].filter((flag) =>
    argv.includes(flag),
  );
  if (actions.length !== 1) {
    log(
      'usage: bun server/maintenance-cli.ts <--status | --drain --expected-revision N | --resume --expected-revision N --expected-runtime-epoch E | --check>',
    );
    return 2;
  }
  const action = actions[0];
  const { expectedRevision, expectedRuntimeEpoch } = parseRevisions(
    argv.filter((arg) => arg !== action),
  );

  if (action === '--check') {
    console.log(JSON.stringify({ entry: 'maintenance', buildId: buildId() }));
    return 0;
  }

  const url = await readDatabaseUrl();
  // 严格对 schema 只读：维护流程绝不执行迁移。
  const opened = await openDatabase(url, { migrate: false });
  try {
    if (action === '--status') {
      console.log(JSON.stringify(await inspectMaintenance(opened.db), null, 2));
      return 0;
    }
    if (action === '--drain') {
      if (expectedRevision === undefined) {
        log('--drain requires --expected-revision N');
        return 2;
      }
      // 拒绝重复/陈旧的停机请求是持久化控制行的职责；
      // 若发生冲突则以退出码 3 退出，以便运行器重新读取状态，而非盲目强推。
      const info = await enterMaintenance(opened.db, expectedRevision);
      console.log(JSON.stringify(info));
      return 0;
    }
    if (expectedRevision === undefined || expectedRuntimeEpoch === undefined) {
      log('--resume requires --expected-revision N and --expected-runtime-epoch E');
      return 2;
    }
    const info = await leaveMaintenance(opened.db, expectedRevision, expectedRuntimeEpoch);
    console.log(JSON.stringify(info));
    return 0;
  } catch (error) {
    if (error instanceof MaintenanceConflict) {
      log(`maintenance CAS conflict: ${error.message}`);
      return 3;
    }
    throw error;
  } finally {
    await opened.close();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    log(`maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
