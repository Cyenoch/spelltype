/**
 * Runtime contract shared between the E2E global setup and the specs.
 *
 * The global setup chooses ports at run time and writes them to
 * `tests/.state/runtime.json`; specs read that file (their processes are separate from
 * the setup process).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FixtureGeneration, FixtureRequestLog, FixtureScenario, FixtureState } from './fixture-server';

/** Instance that keeps the production rate-limit budget (exercised by the auth-limits spec). */
export const LIMITER_INSTANCE = 'app-limit';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const STATE_DIR = path.join(ROOT, 'tests', '.state');
export const RUNTIME_FILE = path.join(STATE_DIR, 'runtime.json');
export const MIGRATIONS_DIR = path.join(ROOT, 'migrations');

export interface RuntimeInfo {
  /** App instance with a DeepSeek key configured (fixture-backed). */
  appUrl: string;
  /** App instance with no `DEEPSEEK_API_KEY`, for the unconfigured-AI path. */
  noKeyAppUrl: string;
  /** App instance that keeps the production rate-limit budget. */
  limitAppUrl: string;
  /** Fixture origin; generation requests are served from `${fixtureUrl}/v1`. */
  fixtureUrl: string;
  persistDir: string;
  appPersistDir: string;
  noKeyPersistDir: string;
  logs: { app: string; noKeyApp: string; limitApp: string };
  startedAt: number;
}

let cached: RuntimeInfo | null = null;

export function runtime(): RuntimeInfo {
  if (cached) return cached;
  if (!fs.existsSync(RUNTIME_FILE)) {
    throw new Error(`E2E runtime file ${RUNTIME_FILE} is missing; run the suite through Playwright so global setup can start the app`);
  }
  cached = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) as RuntimeInfo;
  return cached;
}

/** Talks to the harness control channel that runs on the fixture origin. */
export async function harnessControl<T>(pathname: string, body: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`${runtime().fixtureUrl}/__harness${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as T & { error?: string };
  if (payload && typeof payload === 'object' && typeof payload.error === 'string') throw new Error(`harness ${pathname}: ${payload.error}`);
  return payload;
}

/**
 * Stops and re-boots an application instance on the same port and persist directory. Used to
 * prove Durable Object state survives process reactivation (no production test hooks involved).
 */
export async function restartInstance(instance = 'app'): Promise<void> {
  await harnessControl('/restart', { instance });
}

/**
 * Waits for a genuinely fresh window on the instance that keeps the production rate-limit
 * budget (the general instances run with a test-only budget on their isolated runtime, so
 * only the deliberate-exhaustion spec needs this).
 */
export async function freshAuthWindow(instance = LIMITER_INSTANCE): Promise<void> {
  await harnessControl('/fresh-window', { instance });
}

/**
 * Texts of the payload produced by the last request the room accepted, found through the
 * request log rather than by guessing generation ordinals.
 */
export function acceptedGenerationTexts(state: FixtureState): string[] {
  return acceptedGeneration(state).generation.texts;
}

/**
 * The generation the room accepted plus the request that produced it: the request is what
 * carries the length band and the book size the product's own prompt asked for.
 */
export function acceptedGeneration(state: FixtureState): { request: FixtureRequestLog; generation: FixtureGeneration } {
  for (const request of [...state.requests].reverse()) {
    if (request.responseMode !== 'success' || request.generationIndex === null) continue;
    const generation = state.generations.find((entry) => entry.index === request.generationIndex);
    if (generation) return { request, generation };
  }
  throw new Error('no successful generation in the fixture log');
}

/** Texts of the payload produced by one specific request index. */
export function generationTextsForRequest(state: FixtureState, requestIndex: number): string[] {
  const request = state.requests.find((entry) => entry.index === requestIndex);
  if (!request || request.generationIndex === null) throw new Error(`request ${requestIndex} produced no generation`);
  const generation = state.generations.find((entry) => entry.index === request.generationIndex);
  if (!generation) throw new Error(`generation ${request.generationIndex} missing`);
  return generation.texts;
}

export interface FixtureClient {
  state(): Promise<FixtureState>;
  reset(): Promise<void>;
  /** Sets the behaviour for every following request. */
  scenario(scenario: FixtureScenario): Promise<void>;
  /** Queues one-shot behaviours, consumed in order. */
  queue(scenarios: FixtureScenario[]): Promise<void>;
  /** Releases held (`hang`) requests, which then answer with a success payload. */
  release(): Promise<number>;
}

async function control<T>(fixtureUrl: string, pathname: string, body?: unknown): Promise<T> {
  const response = await fetch(`${fixtureUrl}/__control${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!response.ok) throw new Error(`fixture control ${pathname} failed: ${response.status} ${await response.text()}`);
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
    scenario: async (scenario) => {
      await control(base, '/scenario', scenario);
    },
    queue: async (scenarios) => {
      await control(base, '/queue', { scenarios });
    },
    release: async () => {
      const result = await control<{ released: number }>(base, '/release');
      return result.released;
    },
  };
}
