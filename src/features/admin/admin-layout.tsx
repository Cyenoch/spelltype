import { For, Show, createSignal } from 'solid-js';
import { Link, Outlet, useLocation } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { ui } from '../../ui/primitives';
import { useQueryClient } from '@tanstack/solid-query';

const sections = [
  { to: '/admin', label: '后台总览', number: '01', description: '数据概况', exact: true },
  { to: '/admin/users', label: '用户管理', number: '02', description: '账户与战绩', exact: false },
  {
    to: '/admin/matches',
    label: '对局管理',
    number: '03',
    description: '战斗与结算',
    exact: false,
  },
  {
    to: '/admin/books',
    label: '咒文书管理',
    number: '04',
    description: '主题与咒文',
    exact: false,
  },
  {
    to: '/admin/maintenance',
    label: '系统维护',
    number: '05',
    description: '准入与排空',
    exact: false,
  },
] as const;

export function AdminLayout() {
  const location = useLocation();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = createSignal(false);
  const currentSection = () =>
    sections.find((section) => !section.exact && active(section.to, false));
  const refresh = async () => {
    setRefreshing(true);
    try {
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    } finally {
      setRefreshing(false);
    }
  };
  const active = (to: string, exact: boolean) =>
    exact
      ? location().pathname.replace(/\/$/, '') === to
      : location().pathname === to || location().pathname.startsWith(`${to}/`);
  return (
    <div data-testid="view-admin" class={stylex.props(styles.layout).className}>
      <aside class={stylex.props(ui.panel, styles.sidebar).className}>
        <div class={stylex.props(styles.identity).className}>
          <span class={stylex.props(ui.eyebrow).className}>SPELLTYPE · ADMIN</span>
          <p class={stylex.props(styles.name).className}>管理后台</p>
          <span class={stylex.props(styles.badge).className}>管理员与开发者</span>
        </div>
        <nav aria-label="后台导航" class={stylex.props(styles.navigation).className}>
          <For each={sections}>
            {(section) => (
              <Link
                to={section.to}
                search={{ page: 1, q: '', phase: '' }}
                aria-current={active(section.to, section.exact) ? 'page' : undefined}
                class={
                  stylex.props(styles.item, active(section.to, section.exact) && styles.active)
                    .className
                }
              >
                <span aria-hidden="true" class={stylex.props(styles.index).className}>
                  {section.number}
                </span>
                <span>
                  <span class={stylex.props(styles.label).className}>{section.label}</span>
                  <span class={stylex.props(styles.description).className}>
                    {section.description}
                  </span>
                </span>
              </Link>
            )}
          </For>
        </nav>
        <div class={stylex.props(styles.footer).className}>
          数据只向管理员开放
          <br />
          <Link to="/" search={{}} class={stylex.props(styles.returnLink).className}>
            返回网站
          </Link>
        </div>
      </aside>
      <div class={stylex.props(styles.content).className}>
        <div class={stylex.props(styles.pageTools).className}>
          <nav aria-label="当前位置" class={stylex.props(styles.breadcrumbs).className}>
            <Link to="/admin" search={{}}>
              后台
            </Link>
            <Show when={currentSection()}>
              {(section) => (
                <>
                  <span aria-hidden="true">/</span>
                  <Link to={section().to} search={{ page: 1, q: '', phase: '' }}>
                    {section().label}
                  </Link>
                  <Show when={location().pathname.replace(/\/$/, '') !== section().to}>
                    <span aria-hidden="true">/</span>
                    <span>详情</span>
                  </Show>
                </>
              )}
            </Show>
          </nav>
          <button
            type="button"
            class={stylex.props(ui.button, ui.small).className}
            disabled={refreshing()}
            onClick={() => void refresh()}
          >
            {refreshing() ? '正在刷新…' : '刷新数据'}
          </button>
        </div>
        <Outlet />
      </div>
    </div>
  );
}

const styles = stylex.create({
  layout: {
    display: 'grid',
    gridTemplateColumns: {
      default: '220px minmax(0,1fr)',
      '@media (max-width: 880px)': 'minmax(0,1fr)',
    },
    gap: 24,
    alignItems: 'start',
  },
  sidebar: {
    padding: '26px 14px',
    margin: 0,
    position: { default: 'sticky', '@media (max-width: 880px)': 'static' },
    top: 20,
  },
  identity: { padding: '0 12px 24px', borderBottom: '1px solid var(--line)' },
  name: {
    fontFamily: 'var(--font-display)',
    fontSize: '1.5rem',
    color: 'var(--gold)',
    margin: '10px 0',
  },
  badge: { fontSize: '.72rem', letterSpacing: '.12em', color: 'var(--ink-faint)' },
  navigation: {
    display: 'grid',
    gap: 6,
    paddingTop: 16,
    gridTemplateColumns: {
      default: '1fr',
      '@media (max-width: 880px)': 'repeat(auto-fit,minmax(140px,1fr))',
    },
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: 14,
    padding: '12px',
    borderLeft: '2px solid transparent',
    color: { default: 'var(--ink-dim)', ':hover': 'var(--gold)' },
    backgroundColor: { default: 'transparent', ':hover': '#e5c68e0a' },
    textDecoration: 'none',
  },
  active: { borderLeftColor: 'var(--gold)', color: 'var(--gold)', backgroundColor: '#e5c68e12' },
  index: { fontFamily: 'var(--font-mono)', fontSize: '.7rem', color: 'var(--ink-faint)' },
  label: { display: 'block', fontSize: '.93rem' },
  description: { display: 'block', fontSize: '.72rem', color: 'var(--ink-faint)', marginTop: 2 },
  footer: {
    padding: '22px 12px 0',
    marginTop: 16,
    borderTop: '1px solid var(--line)',
    color: 'var(--ink-faint)',
    fontSize: '.75rem',
    display: { default: 'block', '@media (max-width: 880px)': 'none' },
  },
  returnLink: { display: 'inline-block', marginTop: 12, color: 'var(--gold)' },
  content: { minWidth: 0 },
  pageTools: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 18,
  },
  breadcrumbs: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 10,
    alignItems: 'center',
    fontSize: '.8rem',
    color: 'var(--ink-faint)',
  },
});
