/**
 * Deterministic DeepSeek-compatible HTTP fixture.
 *
 * Test-only infrastructure: never imported by product code. The Worker reaches it
 * because `tests/vite.config.ts` aliases `worker/provider.ts` to
 * `tests/support/test-provider.ts`, which builds the real `@ai-sdk/deepseek` provider
 * with `baseURL` pointed here. Generation therefore travels the real SDK network and
 * structured-output path; only the remote peer is local and deterministic.
 *
 * Scenarios are controlled through `/__control/*` on this same origin. Nothing in the
 * application can reach or observe this server.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SPELL_BOOK_SIZE } from '../../shared/protocol';

export type FixtureDifficulty = 'easy' | 'normal' | 'hard';

export type FixtureMode =
  /** A full valid spell book (`SPELL_BOOK_SIZE` distinct texts) for the requested difficulty. */
  | 'success'
  /** Assistant content is truncated JSON, so object parsing fails. */
  | 'invalid_json'
  /** Valid JSON that violates count/length/charset rules. */
  | 'invalid_schema'
  /** A full book whose spells share one text: the room must reject non-distinct texts. */
  | 'duplicate_texts'
  /** Upstream HTTP failure with a DeepSeek-shaped error body. */
  | 'upstream'
  /** Hold the request open until released (timeout and stale-response scenarios). */
  | 'hang';

export interface FixtureScenario {
  mode: FixtureMode;
  /** Target length range; when omitted it is parsed from the prompt. */
  difficulty?: FixtureDifficulty;
  /** HTTP status for `upstream`. */
  status?: number;
  /** Delay before writing the response. */
  delayMs?: number;
  /** Force an SSE response. */
  stream?: boolean;
  /** Explicit spell texts. */
  texts?: string[];
  /** Explicit spell names. */
  names?: string[];
  /** Free-form label surfaced in `/control/state`. */
  label?: string;
}

export interface FixtureGeneration {
  index: number;
  /** Han numeral appended to every spell name, so tests can identify a generation in the UI. */
  marker: string;
  difficulty: FixtureDifficulty;
  /** One entry per book slot, in the order the room must serve them. */
  texts: string[];
  names: string[];
  elements: string[];
  /**
   * True when every text in `texts` is unique. The room rejects a book with repeated texts, so a
   * `success` generation must always be distinct; the duplicate-text scenario sets this false.
   */
  distinctTexts: boolean;
  responseMode: FixtureMode;
  content: string;
  at: number;
}

export interface FixtureRequestLog {
  index: number;
  at: number;
  url: string;
  model: string;
  stream: boolean;
  wrapperKey: string | null;
  itemProps: string[] | null;
  schemaDetected: boolean;
  responseMode: FixtureMode;
  /** Truncated prompt text, so specs can assert the theme/difficulty really reached the model. */
  prompt: string;
  /** Length contract the fixture followed for this request. */
  lengthRange: [number, number];
  /** Difficulty band the fixture followed, derived from the room's own prompt. */
  difficulty: FixtureDifficulty;
  /** Book size the product's prompt asked for (from its `N 条法术` sentence), or null. */
  askedCount: number | null;
  /** Spells actually returned by this request. */
  returnedCount: number;
  /** Whether those spells had unique texts (a `success` payload always does). */
  distinctTexts: boolean;
  /** Index into `generations` of the payload this request produced (null for an upstream error). */
  generationIndex: number | null;
  releasedAt?: number;
}

export interface FixtureState {
  default: FixtureScenario;
  queue: FixtureScenario[];
  requests: FixtureRequestLog[];
  generations: FixtureGeneration[];
  heldCount: number;
  releasedCount: number;
}

const LENGTH_RANGE: Record<FixtureDifficulty, [number, number]> = {
  easy: [18, 26],
  normal: [27, 38],
  hard: [39, 50],
};

const ELEMENTS = ['arcane', 'fire', 'ice', 'storm'];
/**
 * Han cycles used to build the book. The pool is longer than a full book, so a generation whose
 * spells start at consecutive offsets can never produce two identical texts — the first character
 * already differs — and a later generation (offset shifted by its own index) differs from the
 * previous one as well.
 */
const HAN_POOL = '霜月幽炎雷渊灵焰寒星冥绮岚晞辰暮曦云雾雨雪风花叶露金木水火土山河海川岩';
const NAME_BASES = ['炎爆术', '霜缚咒', '雷引诀', '幽影环', '星辉印', '冰封界', '风吟诀', '月蚀咒'];
const HAN_DIGITS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const TEXT_TAIL = '，魔力凝聚成光。';
const SCHEMA_MARKER = 'Return JSON that conforms to the following schema: ';
/**
 * The room states its difficulty in its own prompt (`难度：困难（每条 text 必须 39 到 50 个字符）`),
 * and it validates the returned book against exactly that difficulty's band. The label is the one
 * unambiguous signal in that prompt: the numbers nearby describe the name length (2 到 12 个汉字)
 * as well, so a numeric scan cannot tell the two rules apart.
 */
const DIFFICULTY_BY_LABEL: Record<string, FixtureDifficulty> = { 简单: 'easy', 普通: 'normal', 困难: 'hard' };
const DIFFICULTY_IN_PROMPT = /难度\s*[:：]\s*(简单|普通|困难)/;
/**
 * The book size the product asks for. Deliberately narrow: the prompt also states a name length
 * (`name 为 2 到 12 个汉字`) and the injected JSON schema repeats that description, so a generic
 * `number + 个/~条` scan picks up "12" from the name rule. Only the book sentence counts.
 */
const BOOK_SIZE_IN_PROMPT = /(\d{1,3})\s*条法术/;

interface FixtureSpell {
  name: string;
  text: string;
  element: string;
}

interface HeldRequest {
  respond: () => void;
}

interface FixtureContext {
  state: FixtureState;
  held: HeldRequest[];
  shape: { wrapperKey: string | null; itemProps: string[] | null };
}

/** Two-digit Han numeral, so a full book of 24 spells can name every slot distinctly. */
function hanNumber(value: number): string {
  if (value < 10) return HAN_DIGITS[value];
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return `${tens === 1 ? '' : HAN_DIGITS[tens]}十${HAN_DIGITS[ones]}`;
}

/** A `length`-character Han run whose first character is fixed by `offset`. */
function hanRun(length: number, offset: number): string {
  let text = '';
  while (text.length < length) text += HAN_POOL[(offset + text.length) % HAN_POOL.length];
  return text;
}

function buildText(length: number, offset: number): string {
  const prefixLength = Math.max(1, length - TEXT_TAIL.length);
  return hanRun(prefixLength, offset) + TEXT_TAIL;
}

function payloadFor(spells: FixtureSpell[], shape: FixtureContext['shape']): string {
  const keys = shape.itemProps ?? ['name', 'text', 'element'];
  const nameKey = keys.find((key) => /name|title/i.test(key)) ?? keys[0];
  const elementKey = keys.find((key) => /element|visual/i.test(key));
  const textKey = keys.find((key) => /text|咒|content/i.test(key)) ?? keys.find((key) => key !== nameKey && key !== elementKey) ?? keys[1];

  const items = spells.map((spell) => {
    const item: Record<string, string> = {};
    for (const key of keys) {
      if (key === nameKey) item[key] = spell.name;
      else if (key === elementKey) item[key] = spell.element;
      else if (key === textKey) item[key] = spell.text;
      else item[key] = spell.text;
    }
    return item;
  });

  return JSON.stringify({ [shape.wrapperKey ?? 'spells']: items });
}

function buildGeneration(
  context: FixtureContext,
  scenario: FixtureScenario,
  difficulty: FixtureDifficulty,
  range: [number, number] = LENGTH_RANGE[difficulty],
  count: number = SPELL_BOOK_SIZE,
): FixtureGeneration {
  const index = context.state.generations.length;
  const marker = hanNumber(index + 1);
  const [min, max] = range;
  const span = Math.max(1, max - min + 1);
  const spells: FixtureSpell[] = [];

  for (let i = 0; i < count; i += 1) {
    spells.push({
      name: scenario.names?.[i] ?? `${NAME_BASES[i % NAME_BASES.length]}${marker}${hanNumber(i + 1)}`,
      // Every spell in one book has the same length (the band walks with the generation) and a
      // distinct Han offset, so the texts are unique and no text is a substring of another — a
      // spec can therefore test for a leaked spell with a plain containment check.
      text: scenario.texts?.[i] ?? buildText(min + (index % span), index + i),
      element: ELEMENTS[i % ELEMENTS.length],
    });
  }

  if (scenario.mode === 'duplicate_texts') {
    for (const spell of spells) spell.text = spells[0].text;
  }
  if (scenario.mode === 'invalid_schema') {
    // Wrong count, out-of-range length and forbidden latin text.
    spells.length = Math.max(1, count - 1);
    spells[0].text = 'abc';
  }

  const texts = spells.map((spell) => spell.text);
  const distinctTexts = new Set(texts).size === texts.length;
  if (scenario.mode === 'success' && !distinctTexts) {
    throw new Error(`fixture bug: repeated spell text in generated book ${index} (${texts.length} spells)`);
  }
  const previous = context.state.generations.at(-1);
  if (scenario.mode === 'success' && previous && previous.texts.some((text) => texts.includes(text))) {
    throw new Error(`fixture bug: generation ${index} repeats a text from generation ${previous.index}`);
  }

  const generation: FixtureGeneration = {
    index,
    marker,
    difficulty,
    texts,
    names: spells.map((spell) => spell.name),
    elements: spells.map((spell) => spell.element),
    distinctTexts,
    responseMode: scenario.mode,
    content: payloadFor(spells, context.shape),
    at: Date.now(),
  };
  context.state.generations.push(generation);
  return generation;
}

function detectShape(schema: unknown): FixtureContext['shape'] {
  const root = (schema as { properties?: Record<string, unknown> } | null)?.properties;
  if (!root) return { wrapperKey: null, itemProps: null };
  for (const [key, value] of Object.entries(root)) {
    const candidate = value as { type?: string; items?: { properties?: Record<string, unknown> } };
    if (candidate.type === 'array' && candidate.items?.properties) {
      return { wrapperKey: key, itemProps: Object.keys(candidate.items.properties) };
    }
  }
  return { wrapperKey: null, itemProps: null };
}

/**
 * Recovers the JSON schema the SDK injects into a system message in `json_object` mode. The marker
 * can be followed by more prose, so the first balanced JSON object is taken rather than assuming the
 * JSON runs to the end of the message.
 */
function firstJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function schemaFromMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) return null;
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (typeof content !== 'string') continue;
    const at = content.indexOf(SCHEMA_MARKER);
    if (at === -1) continue;
    const schema = firstJsonObject(content.slice(at + SCHEMA_MARKER.length));
    if (schema !== null) return schema;
  }
  return null;
}

function promptText(body: unknown): string {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return '';
  return messages
    .map((message) => (typeof (message as { content?: unknown }).content === 'string' ? (message as { content: string }).content : ''))
    .join('\n');
}

/** The band the room itself declared in its prompt, or null when it is not stated. */
function difficultyFromPrompt(prompt: string): FixtureDifficulty | null {
  const label = DIFFICULTY_IN_PROMPT.exec(prompt)?.[1];
  return label ? (DIFFICULTY_BY_LABEL[label] ?? null) : null;
}

function completionBody(payload: string, model: string): unknown {
  return {
    id: `chatcmpl-fixture-${Math.random().toString(36).slice(2, 10)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: payload }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 12 },
  };
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) });
  response.end(payload);
}

function writeSseChunks(response: ServerResponse, payload: string, model: string, truncate: boolean): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const id = `chatcmpl-fixture-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  const send = (delta: unknown, finishReason: string | null) => {
    response.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
    );
  };
  send({ role: 'assistant', content: '' }, null);
  const chunks = truncate ? [payload.slice(0, 24)] : Array.from({ length: Math.ceil(payload.length / 24) }, (_, at) => payload.slice(at * 24, at * 24 + 24));
  for (const chunk of chunks) send({ content: chunk }, null);
  send({}, 'stop');
  response.write('data: [DONE]\n\n');
  response.end();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function snapshot(context: FixtureContext): FixtureState {
  return structuredClone({ ...context.state, heldCount: context.held.length });
}

async function handleCompletion(request: IncomingMessage, response: ServerResponse, context: FixtureContext, body: unknown): Promise<void> {
  const queued = context.state.queue.shift();
  const scenario: FixtureScenario = queued ? { ...queued } : { ...context.state.default };
  response.on('error', () => {});

  const model = String((body as { model?: string })?.model ?? 'deepseek-flash');
  const shape = detectShape(schemaFromMessages((body as { messages?: unknown }).messages));
  context.shape = shape;
  const prompt = promptText(body);
  // A scenario that names a band wins (it pins the answer regardless of the prompt); otherwise the
  // fixture follows the difficulty the room declared, which is the band the room validates against.
  const difficulty: FixtureDifficulty = scenario.difficulty ?? difficultyFromPrompt(prompt) ?? 'normal';
  const range: [number, number] = LENGTH_RANGE[difficulty];
  const askedCount = Number(BOOK_SIZE_IN_PROMPT.exec(prompt)?.[1] ?? Number.NaN);

  context.state.requests.push({
    index: context.state.requests.length,
    at: Date.now(),
    url: request.url ?? '',
    model,
    stream: (body as { stream?: boolean })?.stream === true || scenario.stream === true,
    wrapperKey: shape.wrapperKey,
    itemProps: shape.itemProps,
    schemaDetected: shape.itemProps !== null,
    responseMode: scenario.mode,
    prompt: prompt.slice(0, 4000),
    lengthRange: range,
    difficulty,
    askedCount: Number.isFinite(askedCount) ? askedCount : null,
    returnedCount: 0,
    distinctTexts: false,
    generationIndex: null,
  });
  const requestLog = context.state.requests[context.state.requests.length - 1];

  if (scenario.delayMs) await new Promise<void>((resolve) => setTimeout(resolve, scenario.delayMs));

  const respond = () => {
    if (scenario.mode === 'upstream') {
      writeJson(response, scenario.status ?? 503, { error: { message: 'fixture upstream failure', type: 'service_unavailable', code: 'fixture_error', param: null } });
      return;
    }
    // A released `hang` request answers with a fresh success payload; every other mode
    // keeps its own shape (invalid schema, duplicate texts, ...).
    const generation = buildGeneration(
      context,
      { ...scenario, mode: scenario.mode === 'hang' ? 'success' : scenario.mode },
      difficulty,
      range,
      // Every mode answers with a full book of the contract size; `duplicate_texts` then collapses
      // all of them onto one text, and `invalid_schema` drops one and mangles another.
      SPELL_BOOK_SIZE,
    );
    requestLog.generationIndex = generation.index;
    requestLog.returnedCount = generation.texts.length;
    requestLog.distinctTexts = generation.distinctTexts;
    if (requestLog.stream) {
      writeSseChunks(response, generation.content, model, scenario.mode === 'invalid_json');
      return;
    }
    writeJson(response, 200, completionBody(scenario.mode === 'invalid_json' ? generation.content.slice(0, 24) : generation.content, model));
  };

  if (scenario.mode === 'hang') {
    const { promise, resolve } = Promise.withResolvers<void>();
    context.held.push({
      respond: () => {
        resolve();
        requestLog.releasedAt = Date.now();
        respond();
      },
    });
    response.on('close', () => resolve());
    await promise;
    return;
  }

  respond();
}

async function handleControl(request: IncomingMessage, response: ServerResponse, context: FixtureContext, body: string): Promise<boolean> {
  const path = (request.url ?? '').replace(/^\/__control/, '') || '/state';
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    payload = {};
  }

  if (path === '/reset' && request.method === 'POST') {
    context.state.queue = [];
    context.state.requests = [];
    context.state.generations = [];
    context.state.releasedCount = 0;
    const held = context.held.splice(0, context.held.length);
    for (const entry of held) entry.respond();
    writeJson(response, 200, { ok: true, state: snapshot(context) });
    return true;
  }

  if (path === '/scenario' && request.method === 'POST') {
    context.state.default = { ...(payload as unknown as FixtureScenario) };
    writeJson(response, 200, { ok: true, default: context.state.default });
    return true;
  }

  if (path === '/queue' && request.method === 'POST') {
    const scenarios = (payload.scenarios ?? payload) as FixtureScenario[];
    if (!Array.isArray(scenarios)) {
      writeJson(response, 400, { error: 'expected { scenarios: FixtureScenario[] }' });
      return true;
    }
    context.state.queue = context.state.queue.concat(scenarios.map((scenario) => ({ ...scenario })));
    writeJson(response, 200, { ok: true, queue: context.state.queue });
    return true;
  }

  if (path === '/release' && request.method === 'POST') {
    const held = context.held.splice(0, context.held.length);
    context.state.releasedCount += held.length;
    for (const entry of held) entry.respond();
    writeJson(response, 200, { ok: true, released: held.length });
    return true;
  }

  if (path === '/state') {
    writeJson(response, 200, snapshot(context));
    return true;
  }

  return false;
}

export interface FixtureServer {
  url: string;
  origin: string;
  state(): FixtureState;
  close(): Promise<void>;
}

export interface FixtureServerOptions {
  port?: number;
  /**
   * Test-only control channel under `/__harness/*`, used by the E2E harness to manage the
   * application processes (the auth rate limiter lives in the application process, so a
   * restart is the only way to reset a real budget window). Return `undefined` for
   * unknown paths.
   */
  control?: (path: string, body: unknown) => Promise<unknown | undefined>;
}

export async function startFixtureServer(options: FixtureServerOptions = {}): Promise<FixtureServer> {
  const context: FixtureContext = {
    state: { default: { mode: 'success' }, queue: [], requests: [], generations: [], heldCount: 0, releasedCount: 0 },
    held: [],
    shape: { wrapperKey: null, itemProps: null },
  };

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
          const result = await options.control(url.replace(/^\/__harness/, '') || '/', body ? JSON.parse(body) : {});
          if (result === undefined) writeJson(response, 404, { error: 'unknown harness control endpoint' });
          else writeJson(response, 200, result);
          return;
        }
        if (url.startsWith('/__control')) {
          if (!(await handleControl(request, response, context, body))) writeJson(response, 404, { error: 'unknown control endpoint' });
          return;
        }
        if (request.method === 'POST' && url.endsWith('/chat/completions')) {
          await handleCompletion(request, response, context, body ? JSON.parse(body) : {});
          return;
        }
        writeJson(response, 404, { error: { message: `fixture: unrecognised route ${request.method} ${url}`, type: 'not_found', code: 'fixture_error' } });
      } catch (error) {
        writeJson(response, 500, { error: { message: (error as Error).message, type: 'fixture_error', code: 'fixture_error' } });
      }
    })();
  });

  const listening = Promise.withResolvers<void>();
  server.listen(options.port ?? 0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    url: `${origin}/v1`,
    state: () => snapshot(context),
    close: async () => {
      const held = context.held.splice(0, context.held.length);
      for (const entry of held) entry.respond();
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      await closed.promise;
    },
  };
}
