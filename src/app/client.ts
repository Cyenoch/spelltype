import { hc } from 'hono/client';
import type { AppType } from '../../worker/http/app';

/**
 * The API client, typed from the worker's own route chain. Requests go to this
 * origin so the session cookie travels with them; callers consume a call with
 * `parseResponse`, which returns the success body or throws Hono's
 * `DetailedError` (`statusCode` for control flow, `detail.data.error` to show).
 */
export const client = hc<AppType>('/', { init: { credentials: 'same-origin' } });
