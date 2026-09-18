import { MAX_INPUT_CHARS } from '../../../../shared/protocol';

/** Longest client message the server accepts, in code points. */
const MAX_INPUT_CODE_POINTS = MAX_INPUT_CHARS;

/** Refuses input a spell can never contain: a pasted block, a drop, and Enter. */
export function attachInputGuards(
  textarea: HTMLTextAreaElement,
  handlers: { onRefused(): void; isComposing(): boolean },
): () => void {
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.isComposing && !handlers.isComposing()) {
      // Spells never contain newlines; Enter must not damage the field.
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

/** The field's own cap, applied to a confirmed value before anything else sees it. */
export function clampInput(value: string): { text: string; truncated: boolean } {
  const points = Array.from(value);
  if (points.length <= MAX_INPUT_CODE_POINTS) return { text: value, truncated: false };
  return { text: points.slice(0, MAX_INPUT_CODE_POINTS).join(''), truncated: true };
}

/**
 * What one confirmed change costs: insertions count as attempts and the ones
 * that disagree with the target count as errors, so a retracted mistake stays
 * counted and a pure deletion costs nothing.
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
