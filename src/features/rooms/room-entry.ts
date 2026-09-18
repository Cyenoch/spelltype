import { DetailedError, parseResponse } from 'hono/client';
import type { RoomLocation } from '../../../shared/release';
import { client } from '../../app/client';
import { RELEASE_ID } from '../../app/release-id';

/**
 * What the stable room locator says about the room's owning release, reduced to
 * the one decision a browser bundle must make: attach, hand the whole document
 * over to the room's own release, or stop.
 */
export type RoomEntry =
  | { kind: 'current' }
  | { kind: 'elsewhere'; location: RoomLocation }
  | { kind: 'retired' }
  | { kind: 'gone'; error: unknown }
  | { kind: 'auth'; error: unknown }
  | { kind: 'unavailable'; error: unknown };

/**
 * One stable-API lookup before any room attachment, over HTTP or WebSocket.
 * The locator is the version-independent authority for which release owns a
 * room right now, so a bundle never has to guess — and never attaches to a
 * room its own build cannot serve. `unavailable` is the honest "cannot prove
 * anything" answer: callers may retry, but must not attach.
 */
export async function resolveRoomEntry(roomId: string, signal?: AbortSignal): Promise<RoomEntry> {
  let location: RoomLocation;
  try {
    location = await parseResponse(
      client.api.rooms[':roomId'].location.$get({ param: { roomId } }, { init: { signal } }),
    );
  } catch (error) {
    if (error instanceof DetailedError) {
      // The room does not exist (or the caller may not see it): a terminal fact,
      // unlike a transport or version-service hiccup. A rejected session is its
      // own verdict too — retrying cannot fix it.
      if (error.statusCode === 404 || error.statusCode === 403) return { kind: 'gone', error };
      if (error.statusCode === 401) return { kind: 'auth', error };
    }
    return { kind: 'unavailable', error };
  }
  if (location.state === 'retired') return { kind: 'retired' };
  if (location.releaseId === RELEASE_ID) return { kind: 'current' };
  return { kind: 'elsewhere', location };
}
