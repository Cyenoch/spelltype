import { api, ApiError } from './api';
import { ASSETS } from './assets';
import { ServerClock } from './clock';
import { append, clear, el, setData, setText } from './dom';
import { createBackgroundScene, type BackgroundScene } from './pixi/background';
import { Session } from './session';
import { messageOf, toast } from './toast';
import type { AppContext, AuthMode, RoomLinkState, View } from './context';
import { AuthView } from './views/auth-view';
import { CreateRoomView } from './views/create-view';
import { HomeView } from './views/home-view';
import { GuideView } from './views/guide-view';
import { ProfileView } from './views/profile-view';
import { QueueView } from './views/queue-view';
import { RoomView } from './views/room-view';
import type { Difficulty } from '../shared/protocol';

const ROOM_ID_PATTERN = /^[0-9a-f]{24}$/;
const SMALL_SCREEN_MAX = 880;
const ROOM_PARAM = 'room';

const CONNECTION_LABELS: Record<RoomLinkState, string> = {
  idle: '未进入房间',
  connecting: '正在连接房间…',
  open: '房间已连接',
  reconnecting: '房间重连中…',
  closed: '房间连接已关闭',
};

/** Shell: session, routing, persistent chrome and the PIXI backdrop. */
export class App {
  private readonly session = new Session();
  private readonly clock = new ServerClock();
  private readonly root: HTMLElement;
  private readonly bannerSlot: HTMLElement;
  private readonly fxLayer: HTMLElement;
  private readonly topbar: HTMLElement;
  private readonly navName: HTMLElement;
  private readonly signOutButton: HTMLButtonElement;
  private readonly authLink: HTMLButtonElement;
  private readonly profileLink: HTMLButtonElement;
  private readonly connectionStatus: HTMLElement;
  private readonly content: HTMLElement;
  private smallScreenBanner: HTMLElement | null = null;
  private graphicsBanner: HTMLElement | null = null;
  private current: View | null = null;
  private background: BackgroundScene | null = null;
  private pending: string | null = null;
  private authNotice = '';

  constructor() {
    this.root = this.requireElement('app');
    this.bannerSlot = this.requireElement('banner-slot');
    this.fxLayer = this.requireElement('fx-layer');

    this.navName = el('span', { class: 'topbar__name', testid: 'nav-username', text: '' });
    this.signOutButton = el('button', {
      class: 'btn btn--small btn--ghost',
      type: 'button',
      testid: 'sign-out',
      text: '退出登录',
      on: { click: () => void this.signOut() },
    });
    this.authLink = el('button', {
      class: 'btn btn--small',
      type: 'button',
      testid: 'nav-auth',
      text: '登录 / 注册',
      on: { click: () => this.showAuth('login') },
    });
    this.profileLink = el('button', {
      class: 'btn btn--small',
      type: 'button',
      testid: 'nav-profile',
      text: '我的战绩',
      on: { click: () => this.showProfile() },
    });
    this.connectionStatus = el('span', {
      class: 'conn',
      testid: 'connection-status',
      data: { state: 'idle' },
      attrs: { role: 'status', 'aria-live': 'polite' },
      hidden: true,
      text: CONNECTION_LABELS.idle,
    });

    this.topbar = el(
      'header',
      { class: 'topbar' },
      el(
        'a',
        {
          class: 'brand',
          attrs: { href: '/', 'aria-label': '咒文对决首页' },
          on: {
            click: (event) => {
              if (event instanceof MouseEvent && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
              event.preventDefault();
              this.pending = null;
              this.showHome();
            },
          },
        },
        el('img', { attrs: { src: ASSETS.sigil, alt: '', width: 32, height: 32 } }),
        el('span', { text: '咒文对决' }),
      ),
      this.connectionStatus,
      el('div', { class: 'topbar__spacer' }),
      el('a', {
        class: 'topbar__guide',
        testid: 'nav-guide',
        text: '玩法指南',
        attrs: { href: '/guide' },
        on: {
          click: (event) => {
            if (event instanceof MouseEvent && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
            event.preventDefault();
            this.showGuide();
          },
        },
      }),
      el(
        'div',
        { class: 'topbar__user' },
        this.authLink,
        this.profileLink,
        this.navName,
        this.signOutButton,
      ),
    );

    this.content = el('div', {
      class: 'view-host',
      testid: 'view-host',
      attrs: { tabindex: '-1' },
    });
    this.root.appendChild(this.topbar);
    this.root.appendChild(this.content);

    this.session.subscribe(() => this.renderSession());
  }

  async boot(): Promise<void> {
    this.renderBanners();
    this.renderSession();
    await this.refreshSession();
    void this.startBackground();
    window.addEventListener('popstate', () => this.route(true));
    window.addEventListener('resize', () => this.renderSmallScreenNote());
    window.addEventListener('pagehide', (event) => {
      // Cached pages keep their live scenes and resume them on back navigation.
      if (event.persisted) return;
      this.current?.destroy();
      this.current = null;
      this.background?.destroy();
      this.background = null;
    });
    this.route(true);
  }

  private requireElement(id: string): HTMLElement {
    const node = document.getElementById(id);
    if (!node) throw new Error(`缺少必需的页面元素 #${id}`);
    return node;
  }

  private async refreshSession(): Promise<void> {
    try {
      await this.session.refresh();
    } catch (error) {
      if (Session.isAuthFailure(error)) {
        this.session.clear();
        return;
      }
      toast(messageOf(error, '无法获取登录状态，请检查网络。'), 'error');
    }
  }

  private async startBackground(): Promise<void> {
    try {
      this.background = await createBackgroundScene(this.fxLayer);
    } catch {
      this.reportGraphicsFailure('WebGL 初始化失败');
    }
  }

  private get context(): AppContext {
    return {
      session: this.session,
      clock: this.clock,
      pendingInvite: () => this.pending,
      setPendingInvite: (roomId) => {
        this.pending = roomId;
      },
      inviteUrl: (roomId) => `${location.origin}/?${ROOM_PARAM}=${roomId}`,
      goHome: () => this.showHome(),
      goGuide: () => this.showGuide(),
      goAuth: (mode) => this.showAuth(mode),
      goProfile: () => this.showProfile(),
      goCreate: () => this.showCreate(),
      goQueue: (difficulty) => this.showQueue(difficulty),
      openRoom: (roomId) => this.openRoom(roomId),
      notify: (message, tone) => toast(message, tone),
      reportGraphicsFailure: (reason) => this.reportGraphicsFailure(reason),
      handleAuthFailure: (reason) => this.handleAuthFailure(reason),
      setRoomConnection: (state) => this.renderConnection(state),
    };
  }

  private setView(view: View, url: string, replace = false): void {
    this.current?.destroy();
    clear(this.content);
    this.current = view;
    this.content.appendChild(view.el);
    const currentUrl = location.pathname + location.search;
    if (url !== currentUrl) {
      if (replace) history.replaceState({}, '', url);
      else history.pushState({}, '', url);
    }
    view.update?.();
    // Keyboard and screen-reader users land on the new view, not on the shell.
    window.scrollTo({ top: 0, behavior: 'instant' });
    this.content.focus({ preventScroll: true });
  }

  private route(replace = false): void {
    const roomId = new URLSearchParams(location.search).get(ROOM_PARAM);
    if (!roomId) {
      if (location.pathname === '/guide') {
        this.showGuide(replace);
        return;
      }
      this.showHome(replace);
      return;
    }
    if (!ROOM_ID_PATTERN.test(roomId)) {
      toast('房间号格式不正确，已返回首页。', 'error');
      this.pending = null;
      this.showHome(true);
      return;
    }
    this.pending = roomId;
    if (!this.session.user) {
      this.showAuth('login', true);
      return;
    }
    this.openRoom(roomId, replace);
  }

  private showHome(replace = false): void {
    this.renderConnection('idle');
    this.setView(new HomeView(this.context), '/', replace);
  }

  private showGuide(replace = false): void {
    this.renderConnection('idle');
    this.setView(new GuideView(this.context), '/guide', replace);
  }

  private showAuth(mode: AuthMode = 'login', keepUrl = false): void {
    const view = new AuthView(this.context, mode, this.authNotice);
    this.authNotice = '';
    this.setView(
      view,
      keepUrl ? location.pathname + location.search : '/auth',
      keepUrl,
    );
  }

  private showCreate(): void {
    this.setView(new CreateRoomView(this.context), '/create');
  }

  private showProfile(): void {
    this.setView(new ProfileView(this.context), '/me');
  }

  private showQueue(difficulty: Difficulty): void {
    this.setView(new QueueView(this.context, difficulty), '/match');
  }

  private openRoom(roomId: string, keepUrl = false): void {
    this.pending = roomId;
    if (!this.session.user) {
      this.showAuth('login', true);
      return;
    }
    const view = new RoomView(roomId, this.context);
    this.setView(
      view,
      keepUrl ? location.pathname + location.search : `/?${ROOM_PARAM}=${roomId}`,
      keepUrl,
    );
    void view.start();
  }

  private async signOut(): Promise<void> {
    try {
      await api.logout();
    } catch (error) {
      if (!(error instanceof ApiError && error.isAuthFailure)) {
        toast(messageOf(error, '退出登录失败，请重试。'), 'error');
        return;
      }
    }
    this.pending = null;
    this.showHome(true);
    this.session.clear();
    toast('已退出登录。', 'info');
  }

  private handleAuthFailure(reason: string): void {
    this.authNotice = reason;
    this.showAuth('login', true);
    this.session.clear();
    toast(reason, 'error');
  }

  private renderSession(): void {
    const user = this.session.user;
    setText(this.navName, user ? user.username : '');
    this.navName.hidden = !user;
    this.signOutButton.hidden = !user;
    this.profileLink.hidden = !user;
    this.authLink.hidden = Boolean(user);
    this.current?.update?.();
  }

  private renderConnection(state: RoomLinkState): void {
    const active = this.current instanceof RoomView && state !== 'idle';
    setData(this.connectionStatus, 'state', state);
    setText(this.connectionStatus, CONNECTION_LABELS[state]);
    this.connectionStatus.hidden = !active;
  }

  private renderBanners(): void {
    clear(this.bannerSlot);
    this.smallScreenBanner = el(
      'div',
      {
        class: 'banner banner--warn small-screen-note',
        testid: 'small-screen-warning',
        hidden: true,
      },
      el('span', { class: 'banner__tag', text: '窄屏提示' }),
      el('span', {
        text: '对战推荐使用电脑与实体键盘。',
      }),
    );
    this.graphicsBanner = el(
      'div',
      { class: 'banner banner--warn', testid: 'graphics-warning', hidden: true },
      el('span', { class: 'banner__tag', text: '简洁模式' }),
      el('span', {
        text: '战场画面暂不可用，已切换为文字模式，不影响继续对战。',
      }),
    );
    append(this.bannerSlot, [this.smallScreenBanner, this.graphicsBanner]);
    this.renderSmallScreenNote();
  }

  private renderSmallScreenNote(): void {
    if (!this.smallScreenBanner) return;
    this.smallScreenBanner.hidden = window.innerWidth > SMALL_SCREEN_MAX;
  }

  private reportGraphicsFailure(_reason: string): void {
    if (this.graphicsBanner) this.graphicsBanner.hidden = false;
    this.root.dataset.graphics = 'failed';
    toast('战场画面暂不可用，已切换为文字模式。', 'warn');
  }
}
