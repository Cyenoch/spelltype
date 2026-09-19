/**
 * 由 E2E 测试环境接入的仅测试用模型工厂。
 *
 * 原生服务端通过 `generateSpellSet(modelFactory, input)` 组装生成流程，因此测试环境注入一个
 * 工厂，让它针对本地 fixture（见 `fixture-server.ts`）构建真实的 `@ai-sdk/deepseek` provider。
 * 生成因此走的是真实的 SDK 网络与结构化输出路径；只有远端对端是本地且确定性的。这里的任何
 * 东西都不是产品回退：生产环境针对配置的 DeepSeek 端点构建同样的 provider。
 */
import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';

/** fixture 应答的模型名；生产默认值位于 server/generation/provider.ts。 */
export const FIXTURE_MODEL = 'deepseek-flash';

/**
 * 构建一个指向 fixture 的 DeepSeek 兼容 base URL 的 `LanguageModel` 工厂。
 * `startServer` 接收 `generate: (input) => generateSpellSet(factory, input)`。
 */
export function createFixtureModelFactory(baseUrl: string): () => LanguageModel {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error('E2E harness bug: fixture base URL is empty');
  const provider = createDeepSeek({ apiKey: 'test-fixture-key', baseURL: trimmed });
  return () => provider(FIXTURE_MODEL);
}
