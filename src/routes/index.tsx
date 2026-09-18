import { onMount, Show } from 'solid-js';
import { createFileRoute } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { parseResponse } from 'hono/client';
import { WS_PROTOCOL } from '../../shared/protocol';
import { gameClient } from '../app/client';
import { ReleaseError, type RoomLocation } from '../../shared/release';
import { resolveRoomEntry } from '../features/rooms/room-entry';
import type { RoomLoad } from '../features/rooms/room-session';
import { AuthView } from '../features/auth/auth-view';
import { HomeView } from '../features/home/home-view';
import { RoomView } from '../features/rooms/room-view';
import { ui } from '../ui/primitives';

export const Route = createFileRoute('/')({
  loaderDeps: ({ search }) => ({ roomId: search.room }),
  loader: async ({ deps, context, abortController }): Promise<RoomLoad | null> => {
    if (!deps.roomId || !context.app.session.user) return null;
    // The stable locator speaks first: which release owns this room right now?
    // A room of another retained release is entered by a full document load of
    // its own build — never by this bundle attaching to it. A retired room is
    // over for every build and says so once, without reconnecting.
    const entry = await resolveRoomEntry(deps.roomId, abortController.signal);
    if (entry.kind === 'elsewhere') return { entry: entry.location };
    if (entry.kind === 'retired') return { error: new ReleaseError('release:room_retired') };
    if (entry.kind === 'gone' || entry.kind === 'auth') return { error: entry.error };
    // This build's own release — or the locator itself was unreachable, in
    // which case the direct probe re-raises whatever is actually wrong.
    try {
      const snapshot = await parseResponse(
        gameClient.rooms[':roomId'].$get(
          { param: { roomId: deps.roomId } },
          {
            headers: { 'X-Spelltype-Protocol': WS_PROTOCOL },
            init: { signal: abortController.signal },
          },
        ),
      );
      return { snapshot };
    } catch (error) {
      return { error };
    }
  },
  component: HomeRoute,
});

function HomeRoute() {
  const context = Route.useRouteContext();
  const search = Route.useSearch();
  const initial = Route.useLoaderData();
  return (
    <Show when={search().room} fallback={<HomeView ctx={context().app} />} keyed>
      {(roomId) => (
        <Show
          when={context().app.session.user}
          fallback={<AuthView ctx={context().app} notice={context().notice()} />}
        >
          <Show when={initial()} keyed>
            {(loaded) =>
              'entry' in loaded ? (
                <EntryRedirect location={loaded.entry} />
              ) : (
                <RoomView ctx={context().app} roomId={roomId} initial={loaded} />
              )
            }
          </Show>
        </Show>
      )}
    </Show>
  );
}

/**
 * The room is retained by another release. The handover is a real browser
 * navigation to that release's own entry URL, so its HTML — and only its
 * JS — is loaded for the room; this bundle never touches it.
 */
function EntryRedirect(props: { location: RoomLocation }) {
  onMount(() => {
    window.location.assign(props.location.entryUrl);
  });
  return (
    <section
      class={stylex.props(ui.panel).className}
      role="status"
      data-testid="room-entry-redirect"
    >
      正在进入房间，请稍候…
    </section>
  );
}
