/** Keyboard equivalents only: letters, case, spaces and punctuation meaning stay exact. */
const PUNCTUATION: Readonly<Record<string, string>> = {
  '！': '!',
  '～': '~',
  '。': '.',
  '．': '.',
  '，': ',',
  '？': '?',
  '；': ';',
  '：': ':',
  '“': '"',
  '”': '"',
  '＂': '"',
  '‘': "'",
  '’': "'",
  '＇': "'",
  '（': '(',
  '）': ')',
  '［': '[',
  '］': ']',
  '【': '[',
  '】': ']',
  '〔': '[',
  '〕': ']',
  '｛': '{',
  '｝': '}',
  '＜': '<',
  '＞': '>',
  '《': '<',
  '》': '>',
  '〈': '<',
  '〉': '>',
  '／': '/',
  '＼': '\\',
  '－': '-',
  '＿': '_',
};

/** Correct equivalent punctuation to the target, without changing code-point positions. */
export function normalizeSpellInput(text: string, target: string): string {
  let result = '';
  let copied = 0;
  let offset = 0;
  let targetOffset = 0;
  for (const character of text) {
    if (targetOffset >= target.length) break;
    const expected = target[targetOffset];
    if (
      character !== expected &&
      (PUNCTUATION[character] ?? character) === (PUNCTUATION[expected] ?? expected)
    ) {
      result += text.slice(copied, offset) + expected;
      copied = offset + character.length;
    }
    offset += character.length;
    targetOffset += target.codePointAt(targetOffset)! > 0xffff ? 2 : 1;
  }
  return copied === 0 ? text : result + text.slice(copied);
}
