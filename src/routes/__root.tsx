import { createEffect, onCleanup, onMount, Show, type JSX } from 'solid-js';
import { useMutation } from '@tanstack/solid-query';
import {
  createRootRouteWithContext,
  Link,
  Outlet,
  redirect,
  useLocation,
  useNavigate,
  useRouter,
  type ErrorComponentProps,
} from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { parseResponse, DetailedError } from 'hono/client';
import { client } from '../app/client';
import { createBackgroundScene, type BackgroundScene } from '../pixi/background';
import { messageOf, toast } from '../ui/toast';
import type { AppContext, AppRouterContext, RoomLinkState, WechatLoginError } from '../app/context';
import { ui } from '../ui/primitives';
import { ASSETS } from '../pixi/assets';

interface Search {
  room?: string;
  error?: WechatLoginError;
}

export const Route = createRootRouteWithContext<AppRouterContext>()({
  validateSearch: (raw: Record<string, unknown>): Search => ({
    room: typeof raw.room === 'string' ? raw.room : undefined,
    error:
      raw.error === 'wechat_failed' || raw.error === 'wechat_unavailable' ? raw.error : undefined,
  }),
  beforeLoad: ({ search, context }) => {
    if (search.room && !/^[0-9a-f]{24}$/.test(search.room)) {
      context.app.setPendingInvite(null);
      toast('房间号格式不正确，已返回首页。', 'error');
      throw redirect({ to: '/', search: {}, replace: true });
    }
    if (search.room) context.app.setPendingInvite(search.room);
  },
  component: RootLayout,
  notFoundComponent: () => (
    <section class={stylex.props(ui.panel).className}>
      <h1>页面不存在</h1>
      <Link to="/" search={{}}>
        返回首页
      </Link>
    </section>
  ),
  errorComponent: RouteError,
});

function RootLayout() {
  const context = Route.useRouteContext();
  const search = Route.useSearch();
  const location = useLocation();
  // 玩家当前所在区域决定了横幅的行为：绝不在玩家处于进行中的对局
  // 或匹配队列时强制刷新页面。
  const zone = (): Zone => {
    if (location().pathname === '/' && search().room) return 'room';
    if (location().pathname === '/match') return 'queue';
    return 'free';
  };
  return (
    <Shell
      ctx={context().app}
      connection={context().connection()}
      graphicsFailed={context().graphicsFailed()}
      zone={zone()}
    >
      <Outlet />
    </Shell>
  );
}

/** 玩家当前所处区域（就安全刷新机制而言）。 */
type Zone = 'room' | 'queue' | 'free';

function RouteError(props: ErrorComponentProps) {
  const router = useRouter();
  const location = useLocation();
  // 规则同横幅：显式刷新仅在房间和排队队列之外触发。
  const inRoom = () => location().pathname === '/' && Boolean(location().search.room);
  const inQueue = () => location().pathname === '/match';
  const blocked = () => inRoom() || inQueue();
  return (
    <section class={stylex.props(ui.panel).className} role="alert">
      <h1>页面加载失败</h1>
      <p>{messageOf(props.error)}</p>
      <div class={stylex.props(ui.buttonRow).className}>
        <button class={stylex.props(ui.button).className} onClick={() => void router.invalidate()}>
          重试
        </button>
        <Show
          when={!blocked()}
          fallback={
            <p class={stylex.props(ui.muted).className}>
              {inRoom()
                ? '离开房间后再刷新页面，避免打断对局。'
                : '取消排队并返回首页后再刷新页面。'}
            </p>
          }
        >
          <button
            class={stylex.props(ui.button, ui.primary).className}
            data-testid="app-error-refresh"
            onClick={() => window.location.reload()}
          >
            刷新页面
          </button>
        </Show>
      </div>
    </section>
  );
}
const CONNECTION_LABELS: Record<RoomLinkState, string> = {
  idle: '未进入房间',
  connecting: '正在连接房间…',
  open: '房间已连接',
  reconnecting: '房间重连中…',
  closed: '房间连接已关闭',
};
function Shell(props: {
  ctx: AppContext;
  connection: RoomLinkState;
  graphicsFailed: boolean;
  zone: Zone;
  children: JSX.Element;
}) {
  let fxLayer!: HTMLDivElement;
  let content!: HTMLDivElement;
  const currentLocation = useLocation();
  const navigate = useNavigate();
  const logout = useMutation(() => ({
    mutationFn: async () => {
      try {
        await parseResponse(client.api.logout.$post());
      } catch (error) {
        if (!(error instanceof DetailedError && error.statusCode === 401)) throw error;
      }
    },
    onSuccess: () => {
      props.ctx.setPendingInvite(null);
      props.ctx.session.clear();
      void navigate({ to: '/', search: {} });
      toast('已退出登录。');
    },
    onError: (error) => toast(messageOf(error, '退出登录失败，请重试。'), 'error'),
  }));
  onMount(() => {
    let disposed = false;
    let background: BackgroundScene | undefined;
    void createBackgroundScene(fxLayer)
      .then((scene) => {
        if (disposed) scene.destroy();
        else background = scene;
      })
      .catch(() => {
        if (!disposed) props.ctx.reportGraphicsFailure('WebGL 初始化失败');
      });
    onCleanup(() => {
      disposed = true;
      background?.destroy();
    });
  });
  createEffect(() => {
    void currentLocation().href;
    content?.focus({ preventScroll: true });
  });
  return (
    <>
      <a class={stylex.props(styles.skipLink).className} href="#app">
        跳到主要内容
      </a>
      <div
        id="fx-layer"
        ref={(el) => {
          fxLayer = el;
        }}
        aria-hidden="true"
        class={stylex.props(styles.fx).className}
      />
      <div id="banner-slot" class={stylex.props(styles.banners).className}>
        <Show when={props.ctx.maintenance.draining()}>
          <div
            data-testid="maintenance-banner"
            role="status"
            class={stylex.props(styles.banner, styles.maintenanceBanner).className}
          >
            系统维护中：进行中的对局不受影响，暂时无法开始新的对局；维护结束后即可重新匹配。
          </div>
        </Show>
        <Show when={!props.ctx.maintenance.draining() && props.ctx.maintenance.unavailable()}>
          <div
            data-testid="status-unavailable-banner"
            role="status"
            class={stylex.props(styles.banner, styles.maintenanceBanner).className}
          >
            暂时无法获取服务状态：为保护进行中的对局，已暂停开始新的对局，恢复后可正常匹配。
          </div>
        </Show>
        <Show when={props.ctx.maintenance.assetFailed()}>
          <div
            data-testid="stale-bundle-banner"
            role="status"
            class={stylex.props(styles.banner, styles.maintenanceBanner).className}
          >
            <span>
              {props.zone === 'room'
                ? '页面已有更新，离开房间后再刷新，不影响当前对局。'
                : props.zone === 'queue'
                  ? '页面已有更新，取消排队返回首页后再刷新。'
                  : '页面已有更新，请刷新后继续。'}
            </span>
            <Show when={props.zone === 'free'}>
              <button
                type="button"
                data-testid="stale-bundle-refresh"
                class={stylex.props(ui.button, ui.small).className}
                onClick={() => window.location.reload()}
              >
                刷新页面
              </button>
            </Show>
          </div>
        </Show>
        <div
          data-testid="small-screen-warning"
          class={stylex.props(styles.banner, styles.narrowBanner).className}
        >
          对战推荐使用电脑与实体键盘。
        </div>
        <Show when={props.graphicsFailed}>
          <div data-testid="graphics-warning" class={stylex.props(styles.banner).className}>
            战场画面暂不可用，已切换为文字模式，不影响继续对战。
          </div>
        </Show>
      </div>
      <main
        id="app"
        data-testid="app-root"
        data-graphics={props.graphicsFailed ? 'failed' : 'ready'}
        class={
          stylex.props(
            styles.app,
            currentLocation().pathname.startsWith('/admin') && styles.adminApp,
          ).className
        }
      >
        <header class={stylex.props(styles.topbar).className}>
          <Link
            to="/"
            search={{}}
            class={stylex.props(styles.brand).className}
            aria-label="咒文对决首页"
            onClick={() => props.ctx.setPendingInvite(null)}
          >
            <img src={ASSETS.brandSeal} alt="" width="36" height="37" />
            咒文对决
          </Link>
          <span
            hidden={props.connection === 'idle'}
            data-testid="connection-status"
            data-state={props.connection}
            role="status"
            aria-live="polite"
            class={stylex.props(styles.connection).className}
          >
            {CONNECTION_LABELS[props.connection]}
          </span>
          <div class={stylex.props(styles.spacer).className} />
          <Link
            to="/guide"
            search={{}}
            data-testid="nav-guide"
            class={stylex.props(styles.guide).className}
          >
            玩法指南
          </Link>
          <Show when={props.ctx.session.role === 'admin'}>
            <Link
              to="/admin"
              search={{}}
              data-testid="nav-admin"
              class={stylex.props(styles.guide).className}
            >
              后台
            </Link>
          </Show>
          <div class={stylex.props(styles.user).className}>
            <Show
              when={props.ctx.session.user}
              fallback={
                <button
                  class={stylex.props(ui.button, ui.small).className}
                  data-testid="nav-auth"
                  onClick={() =>
                    void navigate({
                      to: '/auth',
                      search: { room: props.ctx.pendingInvite() ?? undefined },
                    })
                  }
                >
                  微信登录
                </button>
              }
            >
              <button
                class={stylex.props(ui.button, ui.small).className}
                data-testid="nav-profile"
                onClick={() => void navigate({ to: '/me', search: {} })}
              >
                我的战绩
              </button>
              <span class={stylex.props(styles.name).className} data-testid="nav-username">
                {props.ctx.session.user?.username}
              </span>
              <button
                class={stylex.props(ui.button, ui.small, ui.ghost).className}
                data-testid="sign-out"
                disabled={logout.isPending}
                onClick={() => logout.mutate()}
              >
                退出登录
              </button>
            </Show>
          </div>
        </header>
        <div
          ref={(el) => {
            content = el;
          }}
          tabindex="-1"
          data-testid="view-host"
          class={stylex.props(styles.content).className}
        >
          {props.children}
        </div>
      </main>
    </>
  );
}
const styles = stylex.create({
  skipLink: {
    position: 'absolute',
    left: 12,
    top: { default: -60, ':focus': 12 },
    zIndex: 50,
    padding: '10px 16px',
    borderRadius: 'var(--radius-sm)',
    background: '#241d4a',
    color: 'var(--ink)',
    textDecoration: 'none',
  },
  fx: { position: 'fixed', inset: 0, zIndex: -1, pointerEvents: 'none' },
  banners: { position: 'sticky', top: 0, zIndex: 30 },
  banner: {
    padding: '9px 18px',
    fontSize: '.88rem',
    background: 'rgba(58,22,32,.92)',
    color: '#ffd9df',
    borderBottom: '1px solid rgba(255,107,125,.4)',
  },
  narrowBanner: { display: { default: 'none', '@media (max-width: 880px)': 'block' } },
  maintenanceBanner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 12,
    background: 'rgba(35,28,74,.94)',
    color: '#d9dcff',
    borderBottomColor: 'rgba(139,122,255,.45)',
  },
  app: {
    position: 'relative',
    zIndex: 1,
    maxWidth: 1120,
    margin: '0 auto',
    padding: '22px clamp(14px,3vw,34px) 96px',
  },
  adminApp: { maxWidth: 1480 },
  topbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    flexWrap: 'wrap',
    padding: '6px 0 20px',
    marginBottom: 14,
    backgroundImage: 'var(--ornament-divider)',
    backgroundSize: '320px 18px',
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center bottom',
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontFamily: 'var(--font-display)',
    fontSize: '1.12rem',
    letterSpacing: '.22em',
    color: { default: 'var(--ink)', ':hover': 'var(--gold)' },
    textDecoration: 'none',
  },
  connection: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    fontSize: '.8rem',
    padding: '4px 10px',
    borderRadius: 0,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderImageSource: 'var(--frame-inset)',
    borderImageSlice: 48,
    borderImageWidth: '8px',
    borderImageRepeat: 'stretch',
    backgroundImage: 'var(--surface-stone)',
    backgroundSize: '256px 256px',
    color: 'var(--ink-dim)',
  },
  spacer: { flex: '1 1 auto' },
  guide: {
    padding: '8px 4px',
    color: { default: 'var(--ink-dim)', ':hover': 'var(--gold)' },
    fontSize: '.85rem',
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  },
  user: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
    flexWrap: 'wrap',
    fontSize: '.9rem',
    color: 'var(--ink-dim)',
  },
  name: {
    color: 'var(--gold)',
    fontWeight: 600,
    maxWidth: '12em',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  content: { outline: { default: null, ':focus-visible': 'none' } },
});
