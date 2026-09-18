import { Show } from 'solid-js';
import { createFileRoute } from '@tanstack/solid-router';
import { AuthView } from '../features/auth/auth-view';
import { HomeView } from '../features/home/home-view';
import { RoomView } from '../features/rooms/room-view';

export const Route = createFileRoute('/')({ component: HomeRoute });

function HomeRoute() {
  const context = Route.useRouteContext();
  const search = Route.useSearch();
  return (
    <Show when={search().room} fallback={<HomeView ctx={context().app} />} keyed>
      {(roomId) => (
        <Show
          when={context().app.session.user}
          fallback={<AuthView ctx={context().app} notice={context().notice()} />}
        >
          <RoomView ctx={context().app} roomId={roomId} />
        </Show>
      )}
    </Show>
  );
}
