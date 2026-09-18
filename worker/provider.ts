import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';
import type { Env } from './env';

/**
 * Server-configurable model identifier. Verified against the DeepSeek provider
 * documentation (ai-sdk.dev/providers/ai-sdk-providers/deepseek, 2026-09):
 * `deepseek-chat` / `deepseek-reasoner` were retired on 2026-07-24; the current
 * aliases are `deepseek-flash` (current V4.x Flash release), `deepseek-v4-flash`
 * and `deepseek-v4-pro`. The deployed default lives in wrangler.jsonc
 * (`vars.DEEPSEEK_MODEL`) and this constant is only the fallback when the var is
 * absent, so the model id is never a hard product contract.
 */
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';

export class MissingDeepSeekKeyError extends Error {
  constructor() {
    super('deepseek:missing_api_key');
    this.name = 'MissingDeepSeekKeyError';
  }
}

/**
 * True when a DeepSeek credential is present. Safe to expose (boolean only):
 * the key itself is never logged, returned, or embedded in responses.
 */
export function isAiConfigured(env: Env): boolean {
  return typeof env.DEEPSEEK_API_KEY === 'string' && env.DEEPSEEK_API_KEY.trim().length > 0;
}

/**
 * The only place the production provider is constructed. Tests replace this
 * module wholesale (tests/vite.config.ts alias) with a provider that uses the
 * same SDK against a local fixture baseURL; no test flag, fixture data or
 * endpoint override exists in production code.
 */
export function createSpellModel(env: Env): LanguageModel {
  const apiKey = typeof env.DEEPSEEK_API_KEY === 'string' ? env.DEEPSEEK_API_KEY.trim() : '';
  if (!apiKey) throw new MissingDeepSeekKeyError();
  const configured = typeof env.DEEPSEEK_MODEL === 'string' ? env.DEEPSEEK_MODEL.trim() : '';
  return createDeepSeek({ apiKey })(configured || DEFAULT_DEEPSEEK_MODEL);
}
