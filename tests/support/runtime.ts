/**
 * Runtime contract shared between the E2E global setup and the specs.
 *
 * The global setup chooses a port at run time and writes it to
 * `tests/.state/runtime.json`; specs read that file (their processes are separate from
 * the setup process).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FixtureGeneration } from './fixture-generation';
import type { FixtureRequestLog, FixtureState } from './fixture-server';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATE_DIR = path.join(ROOT, 'tests', '.state');
export const RUNTIME_FILE = path.join(STATE_DIR, 'runtime.json');
export const MIGRATIONS_DIR = path.join(ROOT, 'migrations');

export interface RuntimeInfo {
  /** The application instance (fixture-backed DeepSeek key). */
  appUrl: string;
  /** Fixture origin; generation requests are served from `${fixtureUrl}/v1`. */
  fixtureUrl: string;
  persistDir: string;
}

let cached: RuntimeInfo | null = null;

export function runtime(): RuntimeInfo {
  if (cached) return cached;
  if (!fs.existsSync(RUNTIME_FILE)) {
    throw new Error(
      `E2E runtime file ${RUNTIME_FILE} is missing; run the suite through Playwright so global setup can start the app`,
    );
  }
  cached = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) as RuntimeInfo;
  return cached;
}

/** Talks to the harness control channel that runs on the fixture origin. */
async function harnessControl<T>(pathname: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${runtime().fixtureUrl}/__harness${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: string };
  if (payload && typeof payload === 'object' && typeof payload.error === 'string')
    throw new Error(`harness ${pathname}: ${payload.error}`);
  return payload;
}

/**
 * Stops and re-boots the application on the same port and persist directory. Used to prove Durable
 * Object state survives process reactivation (no production test hooks involved).
 */
export async function restartInstance(): Promise<void> {
  await harnessControl('/restart');
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
  };
}
