/**
 * Runtime contract shared between the E2E harness and the specs.
 *
 * The harness boots every part of the stack in-process — the fixture, the PGlite database, the
 * native server (stable API, game and administrator paths on one listener), the WeChat bridge fixture and the
 * Vite UI server — and publishes an address book here. The address book is the one file-based
 * handoff that survives across processes (the unit test spawns children against it), while the
 * live controls (restart, the shared database handle, the maintenance admin) live on the harness
 * singleton in `harness.ts`.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FixtureGeneration } from './fixture-generation';
import type { FixtureRequestLog, FixtureState } from './fixture-server';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runId = (process.env.SPELLTYPE_E2E_RUN_ID ??= randomUUID());
export const STATE_DIR = path.join(ROOT, 'tests', '.state', runId);
export const RUNTIME_FILE = path.join(STATE_DIR, 'runtime.json');
/**
 * Live per-boot data (the PGlite data directory, the Vite dependency cache) lives beneath the
 * run's state dir in a worker- and boot-specific directory. A replacement worker — Playwright
 * reuses `TEST_WORKER_INDEX` across recycled worker processes — gets a fresh path, so it can
 * never meet a crashed predecessor's PGlite directory claim, and two workers never share live
 * files. The suffix is per process, never derived from data the previous boot touched; stale
 * claims are never deleted or stolen. Only RUNTIME_FILE stays a pure function of the run id:
 * it is the cross-process address book, and readers re-derive it from the run id alone.
 */
const workerKey =
  process.env.TEST_WORKER_INDEX === undefined
    ? `standalone-${randomUUID().slice(0, 8)}`
    : `worker-${process.env.TEST_WORKER_INDEX}-${randomUUID().slice(0, 8)}`;
export const WORKER_STATE_DIR = path.join(STATE_DIR, workerKey);
/** The repo's drizzle migration folder the harness passes to `openDatabase`. */
export const MIGRATIONS_DIR = path.join(ROOT, 'drizzle');

export interface RuntimeInfo {
  /** The UI origin (the one Vite server the harness boots). */
  appUrl: string;
  /** The application server: stable API, game paths, admin surface and `/health` on one listener. */
  apiOrigin: string;
  /** Fixture origins; generation requests are served from `${fixtureUrl}/v1`. */
  fixtureUrl: string;
  /** The PGlite data directory. Harness-owned; specs never open these files directly. */
  databaseDir: string;
}

let cached: RuntimeInfo | null = null;

export function runtime(): RuntimeInfo {
  if (cached) return cached;
  if (!fs.existsSync(RUNTIME_FILE)) {
    throw new Error(
      `E2E runtime file ${RUNTIME_FILE} is missing; the harness boots in-process with the tests, so a missing file means the suite bypassed tests/support/test.ts`,
    );
  }
  cached = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) as RuntimeInfo;
  return cached;
}

/** Cache invalidation for the harness: it rewrites the file on every boot. */
export function forgetRuntime(): void {
  cached = null;
}

/**
 * The generation the room accepted plus the request that produced it: the request carries the
 * length band the product's own prompt asked for, and the payload is the book the room serves.
 */
export function acceptedGeneration(state: FixtureState): {
  request: FixtureRequestLog;
  generation: FixtureGeneration;
} {
  const request = state.requests.at(-1);
  if (!request) throw new Error('no generation request in the fixture log');
  const generation = state.generations.find((entry) => entry.index === request.generationIndex);
  if (!generation)
    throw new Error(`generation ${request.generationIndex} missing from the fixture log`);
  return { request, generation };
}

export interface FixtureClient {
  state(): Promise<FixtureState>;
  reset(): Promise<void>;
  setDelay(milliseconds: number): Promise<void>;
}

async function control<T>(fixtureUrl: string, pathname: string, body?: unknown): Promise<T> {
  const response = await fetch(`${fixtureUrl}/__control${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok)
    throw new Error(
      `fixture control ${pathname} failed: ${response.status} ${await response.text()}`,
    );
  return (await response.json()) as T;
}

export function fixture(): FixtureClient {
  const base = runtime().fixtureUrl;
  return {
    state: async () => {
      const response = await fetch(`${base}/__control/state`);
      if (!response.ok) throw new Error(`fixture state failed: ${response.status}`);
      return (await response.json()) as FixtureState;
    },
    reset: async () => {
      await control(base, '/reset');
    },
    setDelay: async (milliseconds) => {
      await control(base, '/delay', milliseconds);
    },
  };
}
