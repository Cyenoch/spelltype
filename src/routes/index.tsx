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
    // 房间由当前服务器直接托管：通过稳定的 API 进行一次权威读取即可决定一切。
    // 会话被拒绝是明确的判定结果，而协议版本拒绝则由房间界面的刷新操作处理。
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
