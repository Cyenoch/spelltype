/** 仅针对键盘等价标点：字母、大小写、空格与标点原义保持严格一致。 */
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

/** 将等价标点校正为目标标点，不改变码点位置。 */
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
