/**
 * 测试夹具提供的确定性法术书：包含一本完整、合规的英文法术书，每条法术配有一句简体中文翻译，
 * 严格契合房间唯一的强生成契约。
 *
 * 完整的句子精准满足 39–50 字符的目标长度而不生硬截断单词。
 * 每对翻译呈现相同的主体、动作和编号封印。封印编号随生成轮次变化，因此后续法术书绝不会复用早期的文本。
 */
import { SPELL_BOOK_SIZE } from '../../shared/protocol';

export interface FixtureGeneration {
  index: number;
  /** 附加到每个法术名称后的罗马数字，便于单次运行识别生成轮次。 */
  marker: string;
  /** 每个法术位对应一条，按房间必须提供它们的顺序排列。 */
  texts: string[];
  /** 与每段文本配对的简体中文行，保持相同顺序。 */
  translations: string[];
  names: string[];
  elements: string[];
  /** 始终为 true：房间会拒绝文本有重复的法术书。 */
  distinctTexts: boolean;
  content: string;
  at: number;
}

/** 请求体 `response_format.json_schema` 所携带 JSON schema 中恢复出的结构。 */
export interface FixtureShape {
  wrapperKey: string | null;
  itemProps: string[] | null;
}

/** 单次生成请求向测试夹具告知的关于所需产出内容的全部信息。 */
export interface GenerationRequest {
  model: string;
  /** 截断后的提示词文本，便于测试用例查看送达模型的主题/长度目标。 */
  prompt: string;
  /** 是否携带了原生 `json_schema` 响应格式，即结构化输出路径是否成功运行。 */
  schemaDetected: boolean;
  /** 测试夹具遵循的长度区间契约，从房间自身的提示词中反解。 */
  range: [number, number];
  shape: FixtureShape;
}

/** 房间的硬编码提示词目标；当提示词未声明区间时的默认兜底。 */
const DEFAULT_RANGE: [number, number] = [39, 50];
/** 提示词中一次性声明的目标 `N to M characters`；数字即为测试夹具的长度区间。 */
const RANGE_IN_PROMPT = /(\d+)\s+to\s+(\d+)\s+characters/;

const ELEMENTS = ['arcane', 'fire', 'ice', 'storm'];
/** 不同的主体词使每条咒文保持清晰可读且中文含义准确。 */
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
/** 每个法术位一个独立的基础名称；生成标记保证跨轮次名称依然唯一。 */
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
interface FixtureSpell {
  name: string;
  text: string;
  translation: string;
  element: string;
}

/**
 * 解析后的 JSON 对象；对于数组和基本类型标量返回 `null`。
 * 请求体作为解析后的 JSON 到达，因此以下各字段均通过此防护读取，而非静默信任数据结构的强制转换。
 */
function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 罗马数字，保证名称与标记均使用纯键盘字符。 */
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
 * 单条消息的纯文本内容。请求体里的消息有两种线上形态：
 * 文本字符串，或 `{ type: 'text', text }` 分片数组（系统消息始终是后者）。
 */
function messageContent(message: unknown): string {
  const content = asObject(message)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const text = asObject(part)?.text;
      return typeof text === 'string' ? text : '';
    })
    .join('\n');
}

/** SDK 发送的消息列表（文本形式）：房间自身的提示词包含在其中。 */
function promptText(messages: unknown): string {
  return Array.isArray(messages) ? messages.map(messageContent).join('\n') : '';
}

/** 读取单次 `/chat/completions` 请求体：模型、提示词以及提示词所要求的内容。 */
export function readGenerationRequest(body: unknown): GenerationRequest {
  const request = asObject(body);
  // 原生结构化输出路径把 JSON schema 放在 `response_format.json_schema.schema`。
  const responseFormat = asObject(request?.response_format);
  const schema =
    responseFormat?.type === 'json_schema'
      ? (asObject(responseFormat.json_schema)?.schema ?? null)
      : null;
  const prompt = promptText(request?.messages);
  // 房间自身提示词声明的区间（`N to M characters`），或未声明时的硬编码默认值 ——
  // 这些数字与提示词用于自身生成目标的数字完全一致。
  const found = RANGE_IN_PROMPT.exec(prompt);
  const range: [number, number] = found ? [Number(found[1]), Number(found[2])] : DEFAULT_RANGE;
  return {
    model: typeof request?.model === 'string' ? request.model : 'unknown',
    prompt: prompt.slice(0, 4000),
    schemaDetected: schema !== null,
    range,
    shape: detectShape(schema),
  };
}

/**
 * 为 `request` 构建法术书，拒绝在法术书内或跨运行复用文本：测试用例通过简单的包含断言检查泄露的法术，
 * 因此文本在任何地方都必须全局唯一。
 * 文本以 `!` 或 `~` 结尾（按席位交替），从而保证标点符号自动修正路径始终可被测试；
 * 按照生成契约名称为英文，且每条文本均按房间 schema 的最新要求携带忠实的简体中文 `translation`。
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
