import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';
import type { AiConfig } from '../config';

/** Default model alias; the server configuration may select another model. */
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
export function isAiConfigured(config: AiConfig): boolean {
  return Boolean(config.apiKey);
}

/** Production model construction; tests inject their own model factory into generation. */
export function createSpellModel(config: AiConfig): LanguageModel {
  if (!config.apiKey) throw new MissingDeepSeekKeyError();
  return createDeepSeek({ apiKey: config.apiKey })(config.model);
}
