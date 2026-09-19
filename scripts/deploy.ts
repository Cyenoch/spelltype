// 宿主机端部署 CLI：本机上应用生命周期的唯一管控入口。
// 由宿主机锁进行串行化控制，全流程采用 fail-closed（故障即关闭）原则，
// 并由 PostgreSQL 中的持久化维护状态驱动：
//
//   bun run deploy build                        [--tag <ref>]
//   bun run deploy secrets
//   bun run deploy install     --image <ref>    # 首次引导启动（应用可能尚未存在）
//   bun run deploy deploy      --image <ref>    [--wait-timeout <s>] [--expect-build <id>]
//   bun run deploy rollback    [--image <ref>]  [--schema-compatible] [--wait-timeout <s>]
//   bun run deploy status
//   bun run deploy maintenance <status|drain|wait|resume> [--timeout <s>] [--http]
//   bun run deploy unlock
//
// 需要宿主机已安装 docker；绝不会将 Docker socket 挂载进应用。
// 运维配置位于 deploy/compose.env；运维手册参见 docs/deployment.md，
// 配置项请参考 deploy/compose.env.example。

import {
  cmdBuild,
  cmdDeploy,
  cmdInstall,
  cmdMaintenance,
  cmdRollback,
  cmdSecrets,
  cmdStatus,
  cmdUnlock,
} from './deploy/flow';

const log = console.error;

const FLAG_TAKES_VALUE: Record<string, true> = {
  '--image': true,
  '--tag': true,
  '--wait-timeout': true,
  '--timeout': true,
  '--expect-build': true,
};
const FLAG_IS_BOOLEAN: Record<string, true> = {
  '--schema-compatible': true,
  '--http': true,
};

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string>;
  booleanFlags: Record<string, true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  const booleanFlags: Record<string, true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAG_TAKES_VALUE[arg] !== undefined) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      flags[arg] = value;
      i++;
    } else if (FLAG_IS_BOOLEAN[arg] !== undefined) {
      booleanFlags[arg] = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags, booleanFlags };
}

function parseSeconds(flags: Record<string, string>, name: string): number | undefined {
  const raw = flags[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be a positive number of seconds`);
  return value;
}

function requireFlag(flags: Record<string, string>, name: string, command: string): string {
  const value = flags[name];
  if (value === undefined) throw new Error(`${command} requires ${name} <ref>`);
  return value;
}

const usage = `usage: bun run deploy <command> [options]

commands:
  build         [--tag <ref>]          build the candidate image from the checkout; prints its image ID
  secrets                              create 0600 credential files from exported env values
  install       --image <ref>          first bootstrap: database -> migrate (draining) -> app -> health -> resume
  deploy        --image <ref>          drain -> stop -> migrate -> start -> verify -> resume
                [--wait-timeout <s>]   drain timeout (default 600s); timeout aborts without killing games
                [--expect-build <id>]  assert the candidate's compiled build identity
  rollback      [--image <ref>]        restore the recorded previous image (or an explicit one);
                [--schema-compatible]  required when the target differs from the current image:
                                       asserts the previous build tolerates the current forward schema
  status                               compose state, maintenance, runtime proof, image history
  maintenance   <status|drain|wait|resume> [--timeout <s>]
                [--http]               wait: bounded, mutation-free readiness wait.
                                       --http: bearer /api/ops/maintenance machine API for
                                       remote CI (SPELLTYPE_OPS_URL or SPELLTYPE_PUBLIC_ORIGIN,
                                       MAINTENANCE_TOKEN[_FILE]); no Docker access needed.
                                       The remote API never replaces containers.
  unlock                               remove a stale host lock (holder must be dead)`;

async function main(): Promise<number> {
  const { positionals, flags, booleanFlags } = parseArgs(process.argv.slice(2));
  const command = positionals[0];
  const subcommand = positionals[1];
  switch (command) {
    case 'build':
      return cmdBuild({ tag: flags['--tag'] });
    case 'secrets':
      return cmdSecrets();
    case 'install':
      return cmdInstall({ image: requireFlag(flags, '--image', 'install') });
    case 'deploy':
      return cmdDeploy({
        image: requireFlag(flags, '--image', 'deploy'),
        waitTimeoutS: parseSeconds(flags, '--wait-timeout'),
        expectBuild: flags['--expect-build'],
      });
    case 'rollback':
      return cmdRollback({
        image: flags['--image'],
        schemaCompatible: booleanFlags['--schema-compatible'] !== undefined,
        waitTimeoutS: parseSeconds(flags, '--wait-timeout'),
      });
    case 'status':
      return cmdStatus();
    case 'maintenance': {
      if (
        subcommand !== 'status' &&
        subcommand !== 'drain' &&
        subcommand !== 'wait' &&
        subcommand !== 'resume'
      ) {
        throw new Error('usage: bun run deploy maintenance <status|drain|wait|resume>');
      }
      return cmdMaintenance(subcommand, {
        timeoutS: parseSeconds(flags, '--timeout'),
        viaHttp: booleanFlags['--http'] !== undefined,
      });
    }
    case 'unlock':
      return cmdUnlock();
    default:
      log(usage);
      return command === undefined || command === 'help' ? 0 : 2;
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    log(`deploy failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export { parseArgs, parseSeconds, requireFlag };
