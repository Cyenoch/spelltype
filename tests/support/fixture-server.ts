/**
 * 确定性的 OpenRouter 兼容 HTTP 测试夹具。
 *
 * 仅作为测试端基础设施：绝不被产品代码引用。
 * 测试脚手架通过 `tests/support/test-provider.ts` 提供的 `generateSpellSet` 组装服务端的 `GenerateSpells` 接缝，
 * 后者构建真实的 `@openrouter/ai-sdk-provider` provider 并将 `baseURL` 指向此处。
 * 因此，咒文生成流程走的是真实的 SDK 网络与原生 JSON-schema 结构化输出路径；
 * 仅有远程对端被替换为本地确定性实现。
 * 法术书本身在 `fixture-generation.ts` 中构建。
 *
 * 测试夹具响应固定的数据结构：针对房间提示词声明的长度区间返回一本完整且合规的法术书。
 * 这也是当前测试场景所需要的唯一响应 —— 生成失败相关的场景已由校验单元测试（`tests/unit/generation-schema.spec.ts`）覆盖，
 * 无需在浏览器端驱动重试策略。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { SPELL_BOOK_SIZE } from '../../shared/protocol';
import {
  buildGeneration,
  readGenerationRequest,
  type FixtureGeneration,
} from './fixture-generation';

export interface FixtureRequestLog {
  index: number;
  at: number;
  model: string;
  /** 截断后的提示词文本，便于测试用例查看到达模型的具体主题。 */
  prompt: string;
  /** 是否检测到了原生 response_format 中的 JSON schema。 */
  schemaDetected: boolean;
  /** 本次请求测试夹具遵循的长度区间契约。 */
  lengthRange: [number, number];
  /** 本次请求实际返回的法术。 */
  returnedCount: number;
  distinctTexts: boolean;
  /** 本次请求产生的载荷在 `generations` 中的索引。 */
  generationIndex: number;
}

export interface FixtureState {
  requests: FixtureRequestLog[];
  generations: FixtureGeneration[];
  /** 仅用于测试的上游网络延迟，在测试场景之间重置。产品代码绝不读取该值。 */
  delayMs: number;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function completionBody(payload: string, model: string): unknown {
  return {
    id: `chatcmpl-fixture-${Math.random().toString(36).slice(2, 10)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content: payload }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 处理单次生成请求：记录请求详情（以便测试用例回溯房间发送的提示词），并以基于该请求构建的法术书作为响应。
 */
async function handleCompletion(
  response: ServerResponse,
  state: FixtureState,
  body: unknown,
): Promise<void> {
  response.on('error', () => {});

  const request = readGenerationRequest(body);
  const generation = buildGeneration(state.generations, request);
  state.requests.push({
    index: state.requests.length,
    at: Date.now(),
    model: request.model,
    prompt: request.prompt,
    schemaDetected: request.schemaDetected,
    lengthRange: request.range,
    returnedCount: SPELL_BOOK_SIZE,
    distinctTexts: generation.distinctTexts,
    generationIndex: generation.index,
  });
  state.generations.push(generation);
  if (state.delayMs > 0) await delay(state.delayMs);

  writeJson(response, 200, completionBody(generation.content, request.model));
}

function handleControl(
  request: IncomingMessage,
  response: ServerResponse,
  state: FixtureState,
  body: unknown,
): boolean {
  const path = (request.url ?? '').replace(/^\/__control/, '') || '/state';

  if (path === '/reset' && request.method === 'POST') {
    state.requests = [];
    state.generations = [];
    state.delayMs = 0;
    writeJson(response, 200, { ok: true, state: structuredClone(state) });
    return true;
  }
  if (path === '/delay' && request.method === 'POST') {
    if (typeof body !== 'number' || !Number.isInteger(body) || body < 0 || body > 30_000) {
      writeJson(response, 400, { error: 'delay must be an integer between 0 and 30000ms' });
      return true;
    }
    state.delayMs = body;
    writeJson(response, 200, { ok: true });
    return true;
  }

  if (path === '/state') {
    writeJson(response, 200, structuredClone(state));
    return true;
  }

  return false;
}

export interface FixtureServer {
  /** 测试提供者所指向的 OpenRouter 兼容基础 URL。 */
  url: string;
  origin: string;
  close(): Promise<void>;
}

export interface FixtureServerOptions {
  /**
   * 挂载在 `/__harness/*` 下的仅用于测试夹具的控制通道，用于在相同数据库上重启应用运行时
   * 并验证已提交房间状态的恢复。未知路径返回 `undefined`。
   */
  control?: (path: string, body: unknown) => Promise<unknown>;
}

export async function startFixtureServer(
  options: FixtureServerOptions = {},
): Promise<FixtureServer> {
  const state: FixtureState = { requests: [], generations: [], delayMs: 0 };

  const server: Server = createServer((request, response) => {
    void (async () => {
      try {
        const url = request.url ?? '';
        if (request.method === 'GET' && (url === '/health' || url === '/')) {
          writeJson(response, 200, { ok: true });
          return;
        }
        const body = request.method === 'POST' ? await readBody(request) : '';
        if (url.startsWith('/__harness') && options.control) {
          const result = await options.control(
            url.replace(/^\/__harness/, '') || '/',
            body ? JSON.parse(body) : {},
          );
          if (result === undefined)
            writeJson(response, 404, { error: 'unknown harness control endpoint' });
          else writeJson(response, 200, result);
          return;
        }
        if (url.startsWith('/__control')) {
          if (!handleControl(request, response, state, body ? JSON.parse(body) : null))
            writeJson(response, 404, { error: 'unknown control endpoint' });
          return;
        }
        if (request.method === 'POST' && url.endsWith('/chat/completions')) {
          await handleCompletion(response, state, body ? JSON.parse(body) : {});
          return;
        }
        writeJson(response, 404, {
          error: {
            message: `fixture: unrecognised route ${request.method} ${url}`,
            type: 'not_found',
            code: 'fixture_error',
          },
        });
      } catch (error) {
        writeJson(response, 500, {
          error: {
            message: (error as Error).message,
            type: 'fixture_error',
            code: 'fixture_error',
          },
        });
      }
    })();
  });

  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    url: `${origin}/v1`,
    close: async () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}
