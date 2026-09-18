/**
 * Deterministic DeepSeek-compatible HTTP fixture.
 *
 * Test-only infrastructure: never imported by product code. The Worker reaches it because
 * `tests/vite.config.ts` aliases `worker/generation/provider.ts` to `tests/support/test-provider.ts`, which
 * builds the real `@ai-sdk/deepseek` provider with `baseURL` pointed here. Generation therefore
 * travels the real SDK network and structured-output path; only the remote peer is local and
 * deterministic. The book itself is built in `fixture-generation.ts`.
 *
 * The fixture answers one shape: a full valid spell book for the band the room's own prompt
 * declares. That is the only response the retained scenarios need — generation *failures* are
 * covered by the validation unit tests (`tests/unit/generation-schema.spec.ts`) rather than by
 * driving the retry policy through a browser.
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
  /** Truncated prompt text, so a spec can see the theme that reached the model. */
  prompt: string;
  /** Whether the SDK's injected JSON schema was found, i.e. the structured-output path ran. */
  schemaDetected: boolean;
  /** Length contract the fixture followed for this request. */
  lengthRange: [number, number];
  /** Spells actually returned by this request. */
  returnedCount: number;
  distinctTexts: boolean;
  /** Index into `generations` of the payload this request produced. */
  generationIndex: number;
}

export interface FixtureState {
  requests: FixtureRequestLog[];
  generations: FixtureGeneration[];
  /** Test-only upstream latency, reset between scenarios. Product code never reads it. */
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
    usage: {
      prompt_tokens: 12,
      completion_tokens: 34,
      total_tokens: 46,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 12,
    },
  };
}

function writeSseChunks(response: ServerResponse, payload: string, model: string): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const id = `chatcmpl-fixture-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  const send = (delta: unknown, finishReason: string | null) => {
    response.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
    );
  };
  send({ role: 'assistant', content: '' }, null);
  for (let at = 0; at < payload.length; at += 24)
    send({ content: payload.slice(at, at + 24) }, null);
  send({}, 'stop');
  response.write('data: [DONE]\n\n');
  response.end();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Serves one generation: the request is logged (so a spec can read back the prompt the room sent)
 * and answered with a book built from it.
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

  if (request.stream) writeSseChunks(response, generation.content, request.model);
  else writeJson(response, 200, completionBody(generation.content, request.model));
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
  /** The DeepSeek-compatible base URL the test provider points at. */
  url: string;
  origin: string;
  close(): Promise<void>;
}

export interface FixtureServerOptions {
  /**
   * Test-only control channel under `/__harness/*`, used by the E2E harness to restart the
   * application process (the only way to prove Durable Object state survives reactivation).
   * Return `undefined` for unknown paths.
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
