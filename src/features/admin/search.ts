import type { AdminListSearch } from '../../../shared/admin';

export function adminPageSearch(raw: Record<string, unknown>): { page: number } {
  const page = Number(raw.page);
  return { page: Number.isSafeInteger(page) && page > 0 && page <= 100_000 ? page : 1 };
}

export function adminListSearch(raw: Record<string, unknown>): AdminListSearch {
  return {
    ...adminPageSearch(raw),
    q: typeof raw.q === 'string' ? raw.q.trim().slice(0, 100) : '',
  };
}

export function parseMatchPhase(value: unknown) {
  switch (value) {
    case 'generating':
    case 'countdown':
    case 'playing':
    case 'finished':
      return value;
    default:
      return '';
  }
}

export function adminMatchSearch(raw: Record<string, unknown>) {
  return { ...adminListSearch(raw), phase: parseMatchPhase(raw.phase) };
}
