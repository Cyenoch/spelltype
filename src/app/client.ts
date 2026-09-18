import { hc } from 'hono/client';
import type { GameAppType, StableAppType } from '../../server/http/app';
import { gameApiBase } from '../../shared/release';
import { RELEASE_ID } from './release-id';

/**
 * The stable API client, typed from the server's own route chain. It serves the
 * version-independent surface (session, profile, activity, release info and the
 * room locator) at this origin so the session cookie travels with every request;
 * callers consume a call with `parseResponse`, which returns the success body or
 * throws Hono's `DetailedError` (`statusCode` for control flow, `detail.data`
 * for the server's JSON error body).
 */
export const client = hc<StableAppType>('/', {
  init: { credentials: 'same-origin' },
});

/**
 * The game API client of this bundle's own release. Every call is
 * version-prefixed (`/api/releases/<RELEASE_ID>/…`) and carries the compiled
 * identity header, so this build can only ever reach the game server — and
 * therefore the rooms and tickets — of the release it was compiled for. The
 * server validates the header against the URL prefix and the runtime it serves;
 * a bundle can never silently attach to another release's room.
 */
export const gameClient = hc<GameAppType>(gameApiBase(RELEASE_ID), {
  init: { credentials: 'same-origin' },
  headers: { 'X-Spelltype-Release': RELEASE_ID },
});
