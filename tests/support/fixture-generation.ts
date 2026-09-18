/**
 * Deterministic spell book the fixture serves: a full, valid book for the difficulty the room's own
 * prompt declares.
 *
 * The room states its difficulty in the prompt (`难度：困难（每条 text 必须 39 到 50 个字符）`) and
 * validates the returned book against exactly that band, so the fixture reads the band back off the
 * prompt instead of guessing it: a book the fixture produces is always one the room will serve.
 */
import { SPELL_BOOK_SIZE } from '../../shared/protocol';

export type FixtureDifficulty = 'easy' | 'normal' | 'hard';

export interface FixtureGeneration {
  index: number;
  /** Han numeral appended to every spell name, so a run can identify a generation. */
  marker: string;
  difficulty: FixtureDifficulty;
  /** One entry per book slot, in the order the room must serve them. */
  texts: string[];
  names: string[];
  elements: string[];
  /** Always true: the room rejects a book with repeated texts. */
  distinctTexts: boolean;
  content: string;
  at: number;
}

/** The shape of the JSON the SDK asked for, recovered from its injected schema. */
export interface FixtureShape {
  wrapperKey: string | null;
  itemProps: string[] | null;
}

/** Everything one generation request tells the fixture about what to produce. */
export interface GenerationRequest {
  model: string;
  /** Truncated prompt text, so a spec can see the theme/difficulty that reached the model. */
  prompt: string;
  /** Whether the SDK's injected JSON schema was found, i.e. the structured-output path ran. */
  schemaDetected: boolean;
  /** Difficulty band the fixture follows, derived from the room's own prompt. */
  difficulty: FixtureDifficulty;
  /** Length contract the fixture followed for this request. */
  range: [number, number];
  shape: FixtureShape;
  /** The SDK asked for a streamed completion. */
  stream: boolean;
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
 * The label is the one unambiguous signal in the prompt: the numbers nearby describe the name length
 * (2 到 12 个汉字) as well, so a numeric scan cannot tell the two rules apart.
 */
const DIFFICULTY_BY_LABEL: Record<string, FixtureDifficulty> = {
  简单: 'easy',
  普通: 'normal',
  困难: 'hard',
};
const DIFFICULTY_IN_PROMPT = /难度\s*[:：]\s*(简单|普通|困难)/;

interface FixtureSpell {
  name: string;
  text: string;
  element: string;
}

/**
 * A parsed JSON object, or `null` for arrays and scalars. The request body arrives as parsed JSON,
 * so every field below is read through this guard rather than through a cast that would silently
 * trust the shape.
 */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function payloadFor(spells: FixtureSpell[], shape: FixtureShape): string {
  const keys = shape.itemProps ?? ['name', 'text', 'element'];
  const nameKey = keys.find((key) => /name|title/i.test(key)) ?? keys[0];
  const elementKey = keys.find((key) => /element|visual/i.test(key));
  const textKey =
    keys.find((key) => /text|咒|content/i.test(key)) ??
    keys.find((key) => key !== nameKey && key !== elementKey) ??
    keys[1];

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

function detectShape(schema: unknown): FixtureShape {
  const root = asObject(asObject(schema)?.properties);
  if (!root) return { wrapperKey: null, itemProps: null };
  for (const [key, value] of Object.entries(root)) {
    const candidate = asObject(value);
    if (candidate?.type !== 'array') continue;
    const itemProps = asObject(asObject(candidate.items)?.properties);
    if (itemProps) return { wrapperKey: key, itemProps: Object.keys(itemProps) };
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
    const content = asObject(message)?.content;
    if (typeof content !== 'string') continue;
    const at = content.indexOf(SCHEMA_MARKER);
    if (at === -1) continue;
    const schema = firstJsonObject(content.slice(at + SCHEMA_MARKER.length));
    if (schema !== null) return schema;
  }
  return null;
}

/** The band the room itself declared in its prompt, or null when it is not stated. */
function difficultyFromPrompt(prompt: string): FixtureDifficulty | null {
  const label = DIFFICULTY_IN_PROMPT.exec(prompt)?.[1];
  return label ? (DIFFICULTY_BY_LABEL[label] ?? null) : null;
}

function messageContent(message: unknown): string {
  const content = asObject(message)?.content;
  return typeof content === 'string' ? content : '';
}

/** The messages the SDK sent, as text: the room's own prompt is among them. */
function promptText(messages: unknown): string {
  return Array.isArray(messages) ? messages.map(messageContent).join('\n') : '';
}

/** Reads one `/chat/completions` body: the model, the prompt, and what the prompt asked for. */
export function readGenerationRequest(body: unknown): GenerationRequest {
  const request = asObject(body);
  const schema = schemaFromMessages(request?.messages);
  const prompt = promptText(request?.messages);
  const difficulty: FixtureDifficulty = difficultyFromPrompt(prompt) ?? 'normal';
  return {
    model: typeof request?.model === 'string' ? request.model : 'deepseek-flash',
    prompt: prompt.slice(0, 4000),
    schemaDetected: schema !== null,
    difficulty,
    range: LENGTH_RANGE[difficulty],
    shape: detectShape(schema),
    stream: request?.stream === true,
  };
}

/**
 * Builds the book for `request`, refusing to repeat a text within the book or across the run: a spec
 * checks for a leaked spell with a plain containment test, so texts must be unique everywhere.
 */
export function buildGeneration(
  previous: readonly FixtureGeneration[],
  request: GenerationRequest,
): FixtureGeneration {
  const index = previous.length;
  const marker = hanNumber(index + 1);
  const [min, max] = request.range;
  const span = Math.max(1, max - min + 1);
  const spells: FixtureSpell[] = [];

  for (let i = 0; i < SPELL_BOOK_SIZE; i += 1) {
    spells.push({
      name: `${NAME_BASES[i % NAME_BASES.length]}${marker}${hanNumber(i + 1)}`,
      // Every spell in one book has the same length (the band walks with the generation) and a
      // distinct Han offset, so the texts are unique and no text is a substring of another.
      text: buildText(min + (index % span), index + i),
      element: ELEMENTS[i % ELEMENTS.length],
    });
  }

  const texts = spells.map((spell) => spell.text);
  const distinctTexts = new Set(texts).size === texts.length;
  if (!distinctTexts)
    throw new Error(
      `fixture bug: repeated spell text in generated book ${index} (${texts.length} spells)`,
    );
  if (previous.some((generation) => generation.texts.some((text) => texts.includes(text)))) {
    throw new Error(`fixture bug: generation ${index} repeats a text from an earlier generation`);
  }

  return {
    index,
    marker,
    difficulty: request.difficulty,
    texts,
    names: spells.map((spell) => spell.name),
    elements: spells.map((spell) => spell.element),
    distinctTexts,
    content: payloadFor(spells, request.shape),
    at: Date.now(),
  };
}
