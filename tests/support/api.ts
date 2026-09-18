/**
 * The public HTTP surface the specs call directly — the same endpoints the client uses — plus the
 * payload norms they read off it: the viewer's own identity, the row a rendered board keys a player
 * by, and the accuracy figure the protocol carries.
 */
import type { BrowserContext } from '@playwright/test';
import { runtime } from './runtime';

export async function apiJson<T>(
  context: BrowserContext,
  url: string,
  init?: {
    method?: string;
    data?: unknown;
    origin?: string;
    /** Extra request headers, e.g. the room snapshot's protocol version header. */
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: T }> {
  const absolute = /^https?:/.test(url) ? url : new URL(url, runtime().appUrl).toString();
  const response = await context.request.fetch(absolute, {
    method: init?.method ?? 'GET',
    data: init?.data,
    // The app rejects state-changing requests without a same-host, same-scheme Origin.
    headers: { origin: init?.origin ?? new URL(absolute).origin, ...init?.headers },
    failOnStatusCode: false,
  });
  const text = await response.text();
  return { status: response.status(), body: (text ? JSON.parse(text) : null) as T };
}

/** A player identity: display name plus the account id, whichever the DOM reports. */
export interface Identity {
  username: string;
  userId: string;
}

export async function selfIdentity(context: BrowserContext): Promise<Identity> {
  const response = await context.request.get('/api/session');
  const body = (await response.json()) as { user: { id: string; username: string } | null };
  if (!body.user) throw new Error('no authenticated user in this context');
  return { username: body.user.username, userId: body.user.id };
}

/** Matches a rendered row whether the DOM keys players by id, by name or by label text. */
export function rowFor<T extends { user: string; text?: string }>(
  rows: T[],
  identity: Identity,
): T | undefined {
  return rows.find(
    (row) =>
      row.user === identity.userId ||
      row.user === identity.username ||
      (row.text ?? '').includes(identity.username),
  );
}

/**
 * Normalises an accuracy figure to percent: the protocol carries a number, which may be a
 * 0–1 ratio or already a percentage.
 */
export function accuracyPercent(value: number | string): number {
  const numeric = typeof value === 'number' ? value : Number(value.replace(/[^\d.]/g, ''));
  return numeric <= 1 ? numeric * 100 : numeric;
}
