import { createSignal, For, onCleanup } from 'solid-js';
import { DetailedError } from 'hono/client';
import * as stylex from '@stylexjs/stylex';

export type Tone = 'info' | 'warn' | 'error' | 'good';
interface Notice {
  id: number;
  message: string;
  tone: Tone;
  ttl: number;
}
const [notices, setNotices] = createSignal<Notice[]>([]);
let nextId = 0;

export function toast(message: string, tone: Tone = 'info', ttl = 4600): void {
  setNotices((items) => [...items, { id: ++nextId, message, tone, ttl }]);
}

function ToastMessage(props: { notice: Notice }) {
  const drop = () => setNotices((items) => items.filter((item) => item.id !== props.notice.id));
  const timer = props.notice.ttl > 0 ? setTimeout(drop, props.notice.ttl) : undefined;
  onCleanup(() => clearTimeout(timer));
  return (
    <div
      class={stylex.props(styles.message, styles[props.notice.tone]).className}
      data-tone={props.notice.tone}
    >
      {props.notice.message}
    </div>
  );
}

export function ToastHost() {
  onCleanup(() => setNotices([]));
  return (
    <div
      id="toast"
      role="status"
      aria-live="polite"
      data-testid="toast"
      data-tone={notices().at(-1)?.tone ?? 'info'}
      class={stylex.props(styles.host).className}
    >
      <For each={notices()}>{(notice) => <ToastMessage notice={notice} />}</For>
    </div>
  );
}

/** The server's own failure line, when the response carried a JSON `{ error }` body. */
function detailOf(error: DetailedError): string | null {
  const body: unknown = error.detail?.data;
  if (!body || typeof body !== 'object' || !('error' in body)) return null;
  const { error: message } = body;
  return typeof message === 'string' && message.trim() !== '' ? message : null;
}

/**
 * One readable line for whatever a request or a route threw. A `DetailedError`'s
 * own message is its status line (`409 Conflict`), which no player should read,
 * so the server's JSON error wins; a `TypeError` means the browser could not
 * complete the request, with its wording replaced by the caller's line.
 */
export function messageOf(error: unknown, fallback = '操作失败，请稍后重试。'): string {
  if (error instanceof DetailedError) return detailOf(error) ?? fallback;
  if (error instanceof TypeError) return fallback;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}

const styles = stylex.create({
  host: {
    position: 'fixed',
    right: 18,
    bottom: 18,
    zIndex: 60,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    maxWidth: 'min(420px,92vw)',
    pointerEvents: 'none',
  },
  message: {
    padding: '14px 20px',
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-inset)',
    borderImageSlice: 48,
    borderImageWidth: '14px',
    borderImageRepeat: 'stretch',
    backgroundColor: '#171825',
    backgroundImage: 'var(--surface-leather)',
    backgroundSize: '256px 256px',
    backgroundRepeat: 'repeat',
    boxShadow: 'var(--shadow)',
    fontSize: '.88rem',
    color: 'var(--ink)',
  },
  info: { color: 'var(--ink)' },
  error: { boxShadow: 'inset 3px 0 #ae5668,var(--shadow)', color: '#ffd8de' },
  warn: { borderImageSource: 'var(--frame-control)', color: '#ffe4b8' },
  good: { boxShadow: 'inset 3px 0 #588b77,var(--shadow)', color: '#d2ffec' },
});
