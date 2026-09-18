/**
 * Deterministic spell book the fixture serves: a full, valid English book with one simplified
 * Chinese translation per spell, matching the room's single hard generation contract.
 *
 * Complete sentences fit the fixed 39–50-character target without cutting words. Each paired
 * translation renders the same subject, action and numbered seal. The seal number changes per
 * generation, so later books never reuse an earlier text.
 */
import { SPELL_BOOK_SIZE } from '../../shared/protocol';

export interface FixtureGeneration {
  index: number;
  /** Roman numeral appended to every spell name, so a run can identify a generation. */
  marker: string;
  /** One entry per book slot, in the order the room must serve them. */
  texts: string[];
  /** The simplified Chinese line paired with each text, same order. */
  translations: string[];
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
  /** Truncated prompt text, so a spec can see the theme/length target that reached the model. */
  prompt: string;
  /** Whether the SDK's injected JSON schema was found, i.e. the structured-output path ran. */
  schemaDetected: boolean;
  /** Length contract the fixture follows, read back from the room's own prompt. */
  range: [number, number];
  shape: FixtureShape;
  /** The SDK asked for a streamed completion. */
  stream: boolean;
}

/** The room's hard prompt target; the fallback when a prompt states no band. */
const DEFAULT_RANGE: [number, number] = [39, 50];
/** The prompt states the target once as `N to M characters`; the numbers are the fixture's band. */
const RANGE_IN_PROMPT = /(\d+)\s+to\s+(\d+)\s+characters/;

const ELEMENTS = ['arcane', 'fire', 'ice', 'storm'];
/** Distinct subjects keep every spell readable and its Chinese meaning exact. */
const SUBJECTS = [
  ['ember', '余烬'],
  ['frost', '寒霜'],
  ['raven', '渡鸦'],
  ['thorn', '荆棘'],
  ['glow', '辉光'],
  ['storm', '风暴'],
  ['hollow', '洞穴'],
  ['lantern', '灯笼'],
  ['cinder', '炭火'],
  ['willow', '柳树'],
  ['mirror', '镜子'],
  ['saffron', '藏红花'],
  ['quill', '羽毛笔'],
  ['vault', '穹顶'],
  ['cobalt', '钴'],
  ['fennel', '茴香'],
  ['harbor', '港湾'],
  ['marble', '大理石'],
  ['onyx', '缟玛瑙'],
  ['petal', '花瓣'],
  ['ripple', '涟漪'],
  ['sable', '紫貂'],
  ['tinder', '火绒'],
  ['umbra', '暗影'],
] as const;
/** One distinct name per book slot; the generation marker keeps names distinct across runs. */
const NAME_BASES = [
  'Ember Bolt',
  'Frost Bind',
  'Storm Call',
  'Raven Mark',
  'Star Sigil',
  'Ice Veil',
  'Wind Verse',
  'Moon Eclipse',
  'Thorn Ring',
  'Ash Requiem',
  'Gale Step',
  'Oath Flame',
  'Quiet Ember',
  'Tide Lock',
  'Hollow Chime',
  'Ivy Cage',
  'Salt Ward',
  'Glass Sparrow',
  'Night Loom',
  'Fen Light',
  'Cinder Psalm',
  'Dew Trap',
  'Slate Oracle',
  'Wren Hex',
];
const ROMAN_STEPS: ReadonlyArray<readonly [number, string]> = [
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];
const SCHEMA_MARKER = 'Return JSON that conforms to the following schema: ';

interface FixtureSpell {
  name: string;
  text: string;
  translation: string;
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

/** Roman numeral, so names and markers stay pure keyboard characters. */
function roman(value: number): string {
  let out = '';
  let rest = value;
  for (const [amount, symbol] of ROMAN_STEPS) {
    while (rest >= amount) {
      out += symbol;
      rest -= amount;
    }
  }
  return out;
}

function payloadFor(spells: FixtureSpell[], shape: FixtureShape): string {
  const keys = shape.itemProps ?? ['name', 'text', 'translation', 'element'];
  const nameKey = keys.find((key) => /name|title/i.test(key)) ?? keys[0];
  const elementKey = keys.find((key) => /element|visual/i.test(key));
  const textKey =
    keys.find((key) => /text|content/i.test(key)) ??
    keys.find((key) => key !== nameKey && key !== elementKey) ??
    keys[1];
  const translationKey = keys.find(
    (key) =>
      key !== nameKey &&
      key !== textKey &&
      key !== elementKey &&
      /translation|chinese|zh/i.test(key),
  );

  const items = spells.map((spell) => {
    const item: Record<string, string> = {};
    for (const key of keys) {
      if (key === nameKey) item[key] = spell.name;
      else if (key === elementKey) item[key] = spell.element;
      else if (key === textKey) item[key] = spell.text;
      else if (key === translationKey) item[key] = spell.translation;
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
  // The band the room's own prompt declares (`N to M characters`), or the hard default when it
  // states none — the same numbers the prompt uses as its generation target.
  const found = RANGE_IN_PROMPT.exec(prompt);
  const range: [number, number] = found ? [Number(found[1]), Number(found[2])] : DEFAULT_RANGE;
  return {
    model: typeof request?.model === 'string' ? request.model : 'deepseek-flash',
    prompt: prompt.slice(0, 4000),
    schemaDetected: schema !== null,
    range,
    shape: detectShape(schema),
    stream: request?.stream === true,
  };
}

/**
 * Builds the book for `request`, refusing to repeat a text within the book or across the run: a spec
 * checks for a leaked spell with a plain containment test, so texts must be unique everywhere.
 * Texts end with `!` or `~` (alternating by slot) so the punctuation auto-correction path is always
 * exercisable, names are English per the generation contract, and each text carries a faithful
 * simplified Chinese `translation` as the room's schema now requires.
 */
export function buildGeneration(
  previous: readonly FixtureGeneration[],
  request: GenerationRequest,
): FixtureGeneration {
  if (NAME_BASES.length !== SPELL_BOOK_SIZE || new Set(NAME_BASES).size !== SPELL_BOOK_SIZE) {
    throw new Error('fixture bug: the name pool must cover the spell book exactly once');
  }
  const index = previous.length;
  const marker = roman(index + 1);
  const spells: FixtureSpell[] = [];

  for (let i = 0; i < SPELL_BOOK_SIZE; i += 1) {
    const ending = i % 2 === 0 ? '!' : '~';
    const [subject, translation] = SUBJECTS[i];
    spells.push({
      name: `${NAME_BASES[i]} ${marker}`,
      text: `Let the ${subject} shatter seal ${index + 1} of midnight${ending}`,
      translation: `让${translation}击碎午夜的第 ${index + 1} 道封印${ending === '!' ? '！' : '～'}`,
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
    texts,
    translations: spells.map((spell) => spell.translation),
    names: spells.map((spell) => spell.name),
    elements: spells.map((spell) => spell.element),
    distinctTexts,
    content: payloadFor(spells, request.shape),
    at: Date.now(),
  };
}
