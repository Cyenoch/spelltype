/**
 * Deploy CLI argument grammar — the boundary between operator input and
 * destructive host operations.
 *
 * The deploy CLI drives drains, container stops and forward schema
 * migrations, so its parser must fail loudly rather than misparse: unknown
 * options are rejected (a typoed `--schema-compatible` must never silently
 * disable the safety acknowledgment), value flags demand a value, timeouts
 * must be positive numbers, and install/deploy demand an explicit `--image`.
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

describe('deploy CLI parseArgs', () => {
  it('splits positionals, value flags and boolean flags', () => {
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

  it('records boolean flags without swallowing neighbors', () => {
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

  it('rejects unknown options instead of ignoring them', () => {
    expect(() => parseArgs(['deploy', '--imag', 'x'])).toThrow('--imag');
  });

  it('rejects a value flag at the end without its value', () => {
    expect(() => parseArgs(['deploy', '--image'])).toThrow('--image requires a value');
  });
});

describe('deploy CLI parseSeconds', () => {
  it('passes through an absent timeout', () => {
    expect(parseSeconds({}, '--wait-timeout')).toBeUndefined();
  });

  it('accepts positive seconds', () => {
    expect(parseSeconds({ '--wait-timeout': '30' }, '--wait-timeout')).toBe(30);
  });

  it('rejects zero, negative and non-numeric timeouts', () => {
    expect(() => parseSeconds({ '--wait-timeout': '0' }, '--wait-timeout')).toThrow('positive');
    expect(() => parseSeconds({ '--wait-timeout': '-5' }, '--wait-timeout')).toThrow('positive');
    expect(() => parseSeconds({ '--wait-timeout': 'later' }, '--wait-timeout')).toThrow('positive');
  });
});

describe('deploy CLI requireFlag', () => {
  it('returns the flag value when present', () => {
    expect(requireFlag({ '--image': 'spelltype:local' }, '--image', 'deploy')).toBe(
      'spelltype:local',
    );
  });

  it('names the command when the required flag is missing', () => {
    expect(() => requireFlag({}, '--image', 'install')).toThrow('install requires --image');
  });
});

describe('waitForDrainReady', () => {
  it('returns as soon as the drain is ready', async () => {
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

  it('keeps polling until ready, then reports the observed status', async () => {
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

  it('times out without mutating anything and reports the blocking counts', async () => {
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

  it('refuses to report ready when the draining revision moved mid-wait', async () => {
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

  it('rejects a replacement revision before the first poll, even when already ready', async () => {
    await rejects(
      waitForDrainReady(() => Promise.resolve(drainStatus({ revision: 9 })), {
        timeoutS: 1,
        expectedRevision: 7,
      }),
      /revision moved 7 -> 9/,
    );
  });

  it('refuses to wait on open maintenance instead of draining it', async () => {
    await rejects(
      waitForDrainReady(() => Promise.resolve(drainStatus({ mode: 'open', ready: true })), {
        timeoutS: 1,
        intervalMs: 1,
      }),
      /maintenance is open/,
    );
  });
});

it('does not follow maintenance redirects or disclose credentials to another path', async () => {
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
