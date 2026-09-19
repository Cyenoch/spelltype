import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query';
import { createRouter, RouterProvider, stringifySearchWith } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { ServerClock } from './clock';
import { createNotificationService } from './notifications';
import { createMaintenanceService } from './maintenance';
import { createSession } from './session';
import { messageOf, toast, ToastHost } from '../ui/toast';
import { installAssetBase } from '../pixi/assets';
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
  const notifications = createNotificationService({ session });
  const maintenance = createMaintenanceService();
  const [pending, setPending] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal('');
  const [connection, setConnection] = createSignal<RoomLinkState>('idle');
  const [graphicsFailed, setGraphicsFailed] = createSignal(false);
  // 静态编译的样式会根据文档基准解析资源 URL，
  // 因此在渲染这些界面前需先注册竞技场图片的基础路径。
  onMount(() => installAssetBase());
  const ctx: AppContext = {
    session,
    queryClient: props.queryClient,
    clock: new ServerClock(),
    notifications,
    maintenance,
    pendingInvite: pending,
    setPendingInvite: setPending,
    notify: toast,
    reportGraphicsFailure: () => {
      if (!graphicsFailed()) toast('战场画面暂不可用，已切换为文字模式。', 'warn');
      setGraphicsFailed(true);
    },
    handleAuthFailure: (reason) => {
      setNotice(reason);
      session.clear();
      // 外层壳组件管理路由，因此重新认证时直接调用其导航。
      void router.navigate({
        to: '/auth',
        search: { room: pending() ?? undefined },
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
    // 房间 ID 均为不透明字符串，包括完全由数字构成的 ID。
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
