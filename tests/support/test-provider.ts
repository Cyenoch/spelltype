/**
 * Test-only replacement for `worker/generation/provider.ts`, wired in by `tests/vite.config.ts`.
 *
 * It exports the same surface as the production module but points the real
 * `@ai-sdk/deepseek` provider at the local fixture (see `fixture-server.ts`) through
 * `TEST_DEEPSEEK_BASE_URL`. Nothing here is a product fallback: production calls the
 * DeepSeek endpoint with the configured key and no override.
 */
import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';

/**
 * Structural mirror of the production binding surface this module needs. The real
 * `worker/env.ts` Env is a superset, and the runtime coupling is enforced by every E2E run
 * (the app only reaches DeepSeek through this module, because tests/vite.config.ts aliases
 * worker/generation/provider.ts to it).
 */
type Env = {
  DEEPSEEK_API_KEY?: string;
  DEEPSEEK_MODEL?: string;
  TEST_DEEPSEEK_BASE_URL?: string;
};

export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';

export class MissingDeepSeekKeyError extends Error {
  constructor() {
    super('DEEPSEEK_API_KEY is not configured');
    this.name = 'MissingDeepSeekKeyError';
  }
}

export function isAiConfigured(env: Env): boolean {
  const key = env.DEEPSEEK_API_KEY;
  return typeof key === 'string' && key.trim().length > 0;
}

export function createSpellModel(env: Env): LanguageModel {
  const key = env.DEEPSEEK_API_KEY?.trim();
  if (!isAiConfigured(env) || !key) throw new MissingDeepSeekKeyError();
  const baseURL = env.TEST_DEEPSEEK_BASE_URL?.trim();
  if (!baseURL)
    throw new Error('E2E harness bug: TEST_DEEPSEEK_BASE_URL is not set for the test provider');
  const provider = createDeepSeek({ apiKey: key, baseURL });
  return provider(env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL);
}
