/**
 * Test-only model factory wired in by the E2E harness.
 *
 * The native server composes generation through `generateSpellSet(modelFactory, input)`, so the
 * harness injects a factory that builds the real `@ai-sdk/deepseek` provider against the local
 * fixture (see `fixture-server.ts`). Generation therefore travels the real SDK network and
 * structured-output path; only the remote peer is local and deterministic. Nothing here is a
 * product fallback: production builds the same provider against the configured DeepSeek endpoint.
 */
import { createDeepSeek } from '@ai-sdk/deepseek';
import type { LanguageModel } from 'ai';

/** The model name the fixture answers; the production default lives in server/generation/provider.ts. */
export const FIXTURE_MODEL = 'deepseek-flash';

/**
 * Builds a `LanguageModel` factory pointed at the fixture's DeepSeek-compatible base URL.
 * `startServer` receives `generate: (input) => generateSpellSet(factory, input)`.
 */
export function createFixtureModelFactory(baseUrl: string): () => LanguageModel {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error('E2E harness bug: fixture base URL is empty');
  const provider = createDeepSeek({ apiKey: 'test-fixture-key', baseURL: trimmed });
  return () => provider(FIXTURE_MODEL);
}
