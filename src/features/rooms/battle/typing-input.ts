import { MAX_INPUT_CHARS } from '../../../../shared/protocol';

/** 服务端可接受的最长客户端消息，以码点计。 */
const MAX_INPUT_CODE_POINTS = MAX_INPUT_CHARS;

/** 拒绝咒文绝不可能包含的输入：整段粘贴、拖放，以及回车。 */
export function attachInputGuards(
  textarea: HTMLTextAreaElement,
  handlers: { onRefused(): void; isComposing(): boolean },
): () => void {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.isComposing && !handlers.isComposing()) {
      // 咒文绝不包含换行；回车不得破坏输入框内容。
      event.preventDefault();
    }
  };
  const handlePaste = (event: ClipboardEvent) => {
    const pasted = event.clipboardData?.getData('text') ?? '';
    if (Array.from(pasted).length > 1) {
      event.preventDefault();
      handlers.onRefused();
    }
  };
  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    handlers.onRefused();
  };

  textarea.addEventListener('keydown', handleKeyDown);
  textarea.addEventListener('paste', handlePaste);
  textarea.addEventListener('drop', handleDrop);
  return () => {
    textarea.removeEventListener('keydown', handleKeyDown);
    textarea.removeEventListener('paste', handlePaste);
    textarea.removeEventListener('drop', handleDrop);
  };
}

/** 输入框自身的上限，在其它任何环节看到该值之前应用于已确认的值。 */
export function clampInput(value: string): { text: string; truncated: boolean } {
  const points = Array.from(value);
  if (points.length <= MAX_INPUT_CODE_POINTS) return { text: value, truncated: false };
  return { text: points.slice(0, MAX_INPUT_CODE_POINTS).join(''), truncated: true };
}

/**
 * 一次确认变化的代价：插入计为尝试，其中与目标不一致的计为错误，
 * 因此被撤回的错误仍被计入，而纯粹的删除不计任何代价。
 */
export function countEdit(
  previous: string,
  next: string,
  target: string,
): { inserted: number; errors: number } {
  const before = Array.from(previous);
  const after = Array.from(next);
  const limit = Math.min(before.length, after.length);
  let head = 0;
  while (head < limit && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < limit - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }
  const inserted = after.length - head - tail;
  if (inserted <= 0) return { inserted: 0, errors: 0 };
  const expected = Array.from(target);
  let errors = 0;
  for (let index = head; index < head + inserted; index += 1) {
    if (after[index] !== expected[index]) errors += 1;
  }
  return { inserted, errors };
}
