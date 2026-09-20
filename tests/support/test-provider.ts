/**
 * 由 E2E 测试环境接入的仅测试用模型工厂。
 *
 * 原生服务端通过 `generateSpellSet(modelFactory, input)` 组装生成流程，因此测试环境注入一个
 * 工厂，让它针对本地 fixture（见 `fixture-server.ts`）构建真实的 `@openrouter/ai-sdk-provider`
 * provider。生成因此走的是真实的 SDK 网络与原生 JSON-schema 结构化输出路径；只有远端对端是
 * 本地且确定性的。这里的任何东西都不是产品回退：生产环境针对配置的 OpenRouter 端点构建同样的
 * provider（见 `server/generation/provider.ts`）。
 */
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { DEFAULT_OPENROUTER_MODEL } from '../../server/generation/provider';
import type { LanguageModel } from 'ai';

/**
 * 构建一个指向 fixture 的 OpenRouter 兼容 base URL 的 `LanguageModel` 工厂。
 * `startServer` 接收 `generate: (input) => generateSpellSet(factory, input)`。
 */
export function createFixtureModelFactory(baseUrl: string): () => LanguageModel {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error('E2E harness bug: fixture base URL is empty');
  const provider = createOpenRouter({ apiKey: 'test-fixture-key', baseURL: trimmed });
  return () => provider(DEFAULT_OPENROUTER_MODEL);
}
