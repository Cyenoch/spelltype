/**
 * 部署 CLI 参数语法解析 —— 运维人员输入与宿主机破坏性操作之间的边界。
 *
 * 部署 CLI 负责驱动排空排水、停止容器以及前向 Schema 迁移，
 * 因此其解析器遇到异常必须坚决报错，绝不能错误解析：拒绝未知选项
 * （拼写错误的 `--schema-compatible` 绝不能静默跳过安全确认）、
 * 取值参数必须提供值、超时时间必须为正数，且 install/deploy 必须显式指定 `--image`。
 */
import { describe, expect, it } from 'bun:test';
import { rejects } from 'node:assert/strict';
import { parseArgs, parseSeconds, requireFlag } from '../../scripts/deploy';
import { waitForDrainReady } from '../../scripts/deploy/maintenance';
import { OpsError, opsDrainStatus } from '../../scripts/deploy/ops';
import type { DrainStatus } from '../../shared/maintenance';

function drainStatus(overrides: Partial<DrainStatus> = {}): DrainStatus {
  return {
    mode: 'draining',
    revision: 7,
    updatedAt: 0,
    activeMatches: 0,
    liveReservations: 0,
    waitingTickets: 0,
    pendingResults: 0,
    runtimeKnown: true,
    runtimeEpoch: 3,
    ready: true,
    ...overrides,
  };
}

describe('部署 CLI parseArgs', () => {
  it('正确拆分位置参数、取值参数和布尔参数', () => {
    const { positionals, flags, booleanFlags } = parseArgs([
      'deploy',
      '--image',
      'sha256:' + 'a'.repeat(64),
      '--wait-timeout',
      '30',
    ]);
    expect(positionals).toEqual(['deploy']);
    expect(flags).toEqual({ '--image': 'sha256:' + 'a'.repeat(64), '--wait-timeout': '30' });
    expect(booleanFlags).toEqual({});
  });

  it('记录布尔参数且不吞掉相邻参数', () => {
    const { positionals, flags, booleanFlags } = parseArgs([
      'rollback',
      '--schema-compatible',
      '--image',
      'spelltype@sha256:' + 'b'.repeat(64),
    ]);
    expect(positionals).toEqual(['rollback']);
    expect(flags['--image']).toBe('spelltype@sha256:' + 'b'.repeat(64));
    expect(booleanFlags['--schema-compatible']).toBe(true);
  });

  it('拒绝未知选项而不是直接忽略', () => {
    expect(() => parseArgs(['deploy', '--imag', 'x'])).toThrow('--imag');
  });

  it('末尾的取值参数若缺失对应的值则拒绝', () => {
    expect(() => parseArgs(['deploy', '--image'])).toThrow('--image requires a value');
  });
});

describe('部署 CLI parseSeconds', () => {
  it('未提供超时参数时透传 undefined', () => {
    expect(parseSeconds({}, '--wait-timeout')).toBeUndefined();
  });

  it('接受正数秒数', () => {
    expect(parseSeconds({ '--wait-timeout': '30' }, '--wait-timeout')).toBe(30);
  });

  it('拒绝零、负数以及非数字超时值', () => {
    expect(() => parseSeconds({ '--wait-timeout': '0' }, '--wait-timeout')).toThrow('positive');
    expect(() => parseSeconds({ '--wait-timeout': '-5' }, '--wait-timeout')).toThrow('positive');
    expect(() => parseSeconds({ '--wait-timeout': 'later' }, '--wait-timeout')).toThrow('positive');
  });
});

describe('部署 CLI requireFlag', () => {
  it('存在参数时返回其对应的值', () => {
    expect(requireFlag({ '--image': 'spelltype:local' }, '--image', 'deploy')).toBe(
      'spelltype:local',
    );
  });

  it('缺失必填参数时指明对应的命令名称', () => {
    expect(() => requireFlag({}, '--image', 'install')).toThrow('install requires --image');
  });
});

describe('waitForDrainReady', () => {
  it('排水排空就绪后立即返回', async () => {
    const seen: number[] = [];
    const status = await waitForDrainReady(
      () => {
        seen.push(1);
        return Promise.resolve(drainStatus());
      },
      { timeoutS: 1, intervalMs: 1 },
    );
    expect(status.ready).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('持续轮询直到就绪，随后返回观察到的状态', async () => {
    let polls = 0;
    const status = await waitForDrainReady(
      () => {
        polls += 1;
        return Promise.resolve(
          drainStatus({ ready: polls >= 3, activeMatches: Math.max(0, 3 - polls) }),
        );
      },
      { timeoutS: 5, intervalMs: 1 },
    );
    expect(polls).toBe(3);
    expect(status.ready).toBe(true);
  });

  it('超时退出且不修改任何状态，并在错误信息中报告阻塞的数量', async () => {
    let polls = 0;
    await rejects(
      waitForDrainReady(
        () => {
          polls += 1;
          return Promise.resolve(drainStatus({ ready: false, activeMatches: 2 }));
        },
        { timeoutS: 0.05, intervalMs: 1 },
      ),
      /active matches 2/,
    );
    expect(polls).toBeGreaterThan(1);
  });

  it('如果在等待期间排水版本发生变更，则拒绝返回就绪', async () => {
    let polls = 0;
    await rejects(
      waitForDrainReady(
        () => {
          polls += 1;
          return Promise.resolve(drainStatus({ revision: polls === 1 ? 7 : 8, ready: polls > 1 }));
        },
        { timeoutS: 1, intervalMs: 1 },
      ),
      /revision moved 7 -> 8/,
    );
  });

  it('在首次轮询前即拒绝不匹配的预期版本，即便当前已就绪', async () => {
    await rejects(
      waitForDrainReady(() => Promise.resolve(drainStatus({ revision: 9 })), {
        timeoutS: 1,
        expectedRevision: 7,
      }),
      /revision moved 7 -> 9/,
    );
  });

  it('拒绝在 open 正常模式下进行等待而不是排水模式', async () => {
    await rejects(
      waitForDrainReady(() => Promise.resolve(drainStatus({ mode: 'open', ready: true })), {
        timeoutS: 1,
        intervalMs: 1,
      }),
      /maintenance is open/,
    );
  });
});

it('不跟随运维重定向，防止向其他路径泄露凭证', async () => {
  let redirectedRequests = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/api/ops/maintenance') {
        return Response.redirect(new URL('/credential-sink', request.url), 302);
      }
      redirectedRequests += 1;
      return Response.json(drainStatus());
    },
  });
  try {
    await rejects(opsDrainStatus({ baseUrl: server.url.origin, token: 'a'.repeat(64) }), OpsError);
    expect(redirectedRequests).toBe(0);
  } finally {
    await server.stop(true);
  }
});
