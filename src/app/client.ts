import { hc } from 'hono/client';
import type { AppType } from '../../server/http/app';
import { WS_PROTOCOL } from '../../shared/protocol';

/**
 * The one API client, typed from the server's own route chain. Every route lives
 * at this origin under the stable `/api` prefix — session, profile, activity,
 * status and the game routes alike — so the session cookie travels with every
 * request and there is no second, versioned surface to keep in sync. Callers
 * consume a call with `parseResponse`, which returns the success body or throws
 * Hono's `DetailedError` (`statusCode` for control flow, `detail.data` for the
 * server's JSON error body).
 */
export const client = hc<AppType>('/', {
  init: { credentials: 'same-origin' },
  headers: { 'X-Spelltype-Protocol': WS_PROTOCOL },
});
