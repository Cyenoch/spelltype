/**
 * The public HTTP surface the specs call directly — the same endpoints the client uses — plus the
 * payload norms they read off it: the viewer's own identity, the row a rendered board keys a player
 * by, and the accuracy figure the protocol carries.
 *
 * Game endpoints live under the stable `/api` root, and the server requires the current wire
 * protocol header on every one of them; the helpers send `X-Spelltype-Protocol` automatically.
 * Tests that must prove a stale or missing protocol is rejected override or omit the header
 * explicitly via `apiJson`'s `headers` — the helper never silently fixes a request that is
 * supposed to fail.
 */
import type { BrowserContext } from '@playwright/test';
import { WS_PROTOCOL } from '../../shared/protocol';
import { runtime } from './runtime';

/**
 * Every request defaults to the app's own origin (the server's same-origin gate demands exactly
 * that origin on state changes), and every game path carries the current protocol header.
 */
export async function apiJson<T>(
  context: BrowserContext,
  url: string,
  init?: {
    method?: string;
    data?: unknown;
    origin?: string;
    /**
     * Merged over the defaults (`X-Spelltype-Protocol`, `Origin`), case-insensitively. A value of
     * `undefined` drops that header from the request entirely — the explicit way to omit the
     * protocol header — while an empty string sends the header with an empty value.
     */
    headers?: Record<string, string | undefined>;
  },
): Promise<{ status: number; body: T }> {
  const absolute = /^https?:/.test(url) ? url : new URL(url, runtime().appUrl).toString();
  const headers: Record<string, string> = {
    // The app rejects state-changing requests without a same-host, same-scheme Origin.
    origin: init?.origin ?? new URL(absolute).origin,
  };
  if (/^\/api\/(rooms|match)\b/.test(new URL(absolute).pathname)) {
    headers['x-spelltype-protocol'] = WS_PROTOCOL;
  }
  for (const [name, value] of Object.entries(init?.headers ?? {})) {
    if (value === undefined) delete headers[name.toLowerCase()];
    else headers[name.toLowerCase()] = value;
  }
  const response = await context.request.fetch(absolute, {
    method: init?.method ?? 'GET',
    data: init?.data,
    headers,
    failOnStatusCode: false,
  });
  const text = await response.text();
  return { status: response.status(), body: (text ? JSON.parse(text) : null) as T };
}

/** A game API path (`/rooms/…`, `/match`) called against the stable `/api` root. */
export async function gameJson<T>(
  context: BrowserContext,
  gamePath: string,
  init?: Parameters<typeof apiJson>[2],
): Promise<{ status: number; body: T }> {
  return apiJson<T>(context, `/api${gamePath}`, init);
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
