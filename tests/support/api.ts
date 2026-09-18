/**
 * The public HTTP surface the specs call directly — the same endpoints the client uses — plus the
 * payload norms they read off it: the viewer's own identity, the row a rendered board keys a player
 * by, and the accuracy figure the protocol carries.
 *
 * Game endpoints are release-scoped (`/api/releases/<id>/…`), and the server requires the client
 * release header on them; the helpers send the release this run is currently testing with. Tests
 * that must prove a stale or missing version is rejected override or omit the header explicitly
 * via `apiJson`'s `headers` — the helper never silently fixes a request that is supposed to fail.
 */
import type { BrowserContext } from '@playwright/test';
import { gameApiBase } from '../../shared/release';
import { runtime } from './runtime';
import { WS_PROTOCOL } from '../../shared/protocol';

/**
 * The release id this run's pages are built with. The harness records the initial release in the
 * runtime file, and the A/B scenario switches it after a real activation.
 */
export function testReleaseId(): string {
  return runtime().releaseId;
}

export async function apiJson<T>(
  context: BrowserContext,
  url: string,
  init?: {
    method?: string;
    data?: unknown;
    origin?: string;
    /**
     * Merged over the defaults (`X-Spelltype-Release`, `Origin`), case-insensitively. A value of
     * `undefined` drops that header from the request entirely — the explicit way to omit the
     * release header — while an empty string sends the header with an empty value.
     */
    headers?: Record<string, string | undefined>;
  },
): Promise<{ status: number; body: T }> {
  const absolute = /^https?:/.test(url) ? url : new URL(url, runtime().appUrl).toString();
  const headers: Record<string, string> = {
    'x-spelltype-release': testReleaseId(),
    // The app rejects state-changing requests without a same-host, same-scheme Origin.
    origin: init?.origin ?? new URL(absolute).origin,
  };
  if (
    (init?.method ?? 'GET').toUpperCase() === 'GET' &&
    /^\/api\/releases\/[0-9a-f]{32}\/rooms\/[0-9a-f]{24}\/?$/.test(new URL(absolute).pathname)
  ) {
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

/**
 * A game API path (`/rooms/…`, `/match`, `/rooms/<id>/leave`) called against the release this
 * run currently identifies with: release-scoped URL plus the required release header.
 */
export async function gameJson<T>(
  context: BrowserContext,
  gamePath: string,
  init?: Parameters<typeof apiJson>[2],
): Promise<{ status: number; body: T }> {
  return apiJson<T>(context, `${gameApiBase(testReleaseId())}${gamePath}`, init);
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
