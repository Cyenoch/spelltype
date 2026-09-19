import { Show } from 'solid-js';
import { createFileRoute } from '@tanstack/solid-router';
import { parseResponse } from 'hono/client';
import { client } from '../app/client';
import type { RoomLoad } from '../features/rooms/room-session';
import { AuthView } from '../features/auth/auth-view';
import { HomeView } from '../features/home/home-view';
import { RoomView } from '../features/rooms/room-view';

export const Route = createFileRoute('/')({
  loaderDeps: ({ search }) => ({ roomId: search.room }),
  loader: async ({ deps, context, abortController }): Promise<RoomLoad | null> => {
    if (!deps.roomId || !context.app.session.user) return null;
    // The room lives on this very server: one authoritative read over the
    // stable API decides everything. A rejected session is its own verdict,
    // and a protocol refusal is answered by the room surface's refresh action.
    try {
      const snapshot = await parseResponse(
        client.api.rooms[':roomId'].$get(
          { param: { roomId: deps.roomId } },
          {
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
          fallback={
            <AuthView ctx={context().app} error={search().error} notice={context().notice()} />
          }
        >
          <Show when={initial()} keyed>
            {(loaded) => <RoomView ctx={context().app} roomId={roomId} initial={loaded} />}
          </Show>
        </Show>
      )}
    </Show>
  );
}
