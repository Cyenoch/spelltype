import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import type { AiConfig } from '../config';

/** 默认模型别名；服务端配置可选择其他模型。 */
export const DEFAULT_OPENROUTER_MODEL = 'google/gemini-3.8-flash';

export class MissingOpenRouterKeyError extends Error {
  constructor() {
    super('openrouter:missing_api_key');
    this.name = 'MissingOpenRouterKeyError';
  }
}

/**
 * 当配置了 OpenRouter 凭据时返回 true。可安全向外暴露（仅为布尔值）：
 * 密钥本身绝不会被打印到日志中，亦不会返回或嵌入在响应体中。
 */
export function isAiConfigured(config: AiConfig): boolean {
  return Boolean(config.apiKey);
}

/** 生产环境模型构造函数；单元测试在生成阶段注入自有的模型工厂。 */
export function createSpellModel(config: AiConfig): LanguageModel {
  if (!config.apiKey) throw new MissingOpenRouterKeyError();
  return createOpenRouter({ apiKey: config.apiKey })(config.model);
}
