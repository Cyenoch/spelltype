export type Tone = 'info' | 'warn' | 'error' | 'good';

const ICONS: Record<Tone, string> = {
  info: '✦',
  warn: '⚠',
  error: '✖',
  good: '✔',
};

/** Transient message in the live region (screen readers announce it). */
export function toast(message: string, tone: Tone = 'info', ttl = 4600): void {
  const host = document.getElementById('toast');
  if (!host) return;
  host.dataset.tone = tone;

  const node = document.createElement('div');
  node.className = 'toast-msg';
  node.dataset.tone = tone;
  node.textContent = `${ICONS[tone]} ${message}`;
  host.appendChild(node);

  const drop = () => node.remove();
  if (ttl > 0) window.setTimeout(drop, ttl);
  node.addEventListener('click', drop);
}

export function messageOf(error: unknown, fallback = '操作失败，请稍后重试。'): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return fallback;
}
