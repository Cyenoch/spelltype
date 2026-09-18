import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query';
import { createRouter, RouterProvider, stringifySearchWith } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { ServerClock } from './clock';
import { createSession } from './session';
import { messageOf, toast, ToastHost } from '../ui/toast';
import type { AppContext, AppRouterContext, RoomLinkState } from './context';
import { routeTree } from '../routeTree.gen';

export function App() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  onCleanup(() => queryClient.clear());
  return (
    <QueryClientProvider client={queryClient}>
      <Application queryClient={queryClient} />
    </QueryClientProvider>
  );
}

function Application(props: { queryClient: QueryClient }) {
  const session = createSession(props.queryClient);
  const [pending, setPending] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal('');
  const [connection, setConnection] = createSignal<RoomLinkState>('idle');
  const [graphicsFailed, setGraphicsFailed] = createSignal(false);
  const ctx: AppContext = {
    session,
    queryClient: props.queryClient,
    clock: new ServerClock(),
    pendingInvite: pending,
    setPendingInvite: setPending,
    inviteUrl: (room) => `${location.origin}/?room=${room}`,
    notify: toast,
    reportGraphicsFailure: () => {
      if (!graphicsFailed()) toast('战场画面暂不可用，已切换为文字模式。', 'warn');
      setGraphicsFailed(true);
    },
    handleAuthFailure: (reason) => {
      setNotice(reason);
      session.clear();
      // The shell owns the router, so re-authentication navigates with it.
      void router.navigate({
        to: '/auth',
        search: { mode: 'login', room: pending() ?? undefined },
      });
      toast(reason, 'error');
    },
    setRoomConnection: setConnection,
  };
  const router = createAppRouter({ app: ctx, notice, connection, graphicsFailed });
  createEffect(() => {
    if (session.error) toast(messageOf(session.error, '无法获取登录状态，请检查网络。'), 'error');
  });
  return (
    <>
      <Show
        when={!session.pending}
        fallback={
          <div class={stylex.props(styles.boot).className} role="status">
            正在唤醒竞技场…
          </div>
        }
      >
        <RouterProvider router={router} />
      </Show>
      <ToastHost />
    </>
  );
}

function createAppRouter(context: AppRouterContext) {
  return createRouter({
    routeTree,
    context,
    defaultPreload: false,
    scrollRestoration: true,
    // Room IDs are opaque strings, including IDs consisting entirely of digits.
    parseSearch: (search) => Object.fromEntries(new URLSearchParams(search)),
    stringifySearch: stringifySearchWith(String),
  });
}

declare module '@tanstack/solid-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}

const styles = stylex.create({
  boot: { paddingTop: '18vh', textAlign: 'center', color: 'var(--ink-dim)' },
});
