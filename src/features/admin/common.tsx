import { createEffect, createSignal, Show, type JSX } from 'solid-js';
import { Link } from '@tanstack/solid-router';
import * as stylex from '@stylexjs/stylex';
import { DetailedError } from 'hono/client';
import { ui } from '../../ui/primitives';
import { formatAccuracyPercent } from '../../ui/format';
import { messageOf } from '../../ui/toast';
import { adminStyles, commonStyles } from './admin.styles';

const dateFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const numberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

export function formatDate(timestamp: number | null): string {
  return timestamp === null ? '—' : dateFormatter.format(timestamp);
}

export function formatNumber(value: number | null): string {
  return value === null ? '—' : numberFormatter.format(value);
}

export function formatPercent(value: number | null): string {
  return formatAccuracyPercent(value);
}

export function AdminHeading(props: {
  title: string;
  description?: string;
  children?: JSX.Element;
}) {
  return (
    <header class={stylex.props(commonStyles.heading).className}>
      <div>
        <h1 class={stylex.props(commonStyles.title).className}>{props.title}</h1>
        <Show when={props.description}>
          <p class={stylex.props(commonStyles.description).className}>{props.description}</p>
        </Show>
      </div>
      {props.children}
    </header>
  );
}

export function AdminPanel(props: { title?: string; children: JSX.Element }) {
  return (
    <section class={stylex.props(ui.panel, commonStyles.panel).className}>
      <Show when={props.title}>
        <h2 class={stylex.props(commonStyles.panelTitle).className}>{props.title}</h2>
      </Show>
      {props.children}
    </section>
  );
}

export function AdminStat(props: { label: string; value: JSX.Element }) {
  return (
    <div class={stylex.props(ui.tile).className}>
      <div class={stylex.props(ui.tileLabel).className}>{props.label}</div>
      <div
        class={
          stylex.props(
            ui.tileValue,
            typeof props.value === 'string' && props.value.length > 12 && commonStyles.longStat,
          ).className
        }
      >
        {props.value}
      </div>
    </div>
  );
}

export function AdminEmpty(props: { children?: JSX.Element }) {
  return (
    <div role="status" class={stylex.props(commonStyles.empty).className}>
      {props.children ?? '暂无记录。'}
    </div>
  );
}

export function AdminQueryState(props: {
  query: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown };
  children: JSX.Element;
}) {
  const notFound = () =>
    props.query.error instanceof DetailedError && props.query.error.statusCode === 404;
  return (
    <Show
      when={!props.query.isError}
      fallback={
        <AdminPanel>
          <div role="alert" class={stylex.props(commonStyles.error).className}>
            <h2>{notFound() ? '记录不存在' : '数据暂时无法读取'}</h2>
            <p>{messageOf(props.query.error, '请稍后重试。')}</p>
            <button
              type="button"
              class={stylex.props(ui.button, ui.small).className}
              onClick={() => void props.query.refetch()}
            >
              重新读取
            </button>
          </div>
        </AdminPanel>
      }
    >
      <Show when={!props.query.isPending} fallback={<AdminEmpty>正在读取数据…</AdminEmpty>}>
        {props.children}
      </Show>
    </Show>
  );
}

export function AdminPagination(props: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  const pages = () => Math.max(1, Math.ceil(props.total / props.pageSize));
  return (
    <nav aria-label="分页" class={stylex.props(commonStyles.pagination).className}>
      <span class={stylex.props(adminStyles.muted).className}>
        共 {formatNumber(props.total)} 条 · 第 {props.page} / {pages()} 页
      </span>
      <div class={stylex.props(commonStyles.actions).className}>
        <button
          type="button"
          class={stylex.props(ui.button, ui.small).className}
          disabled={props.page <= 1}
          onClick={() => props.onPage(props.page - 1)}
        >
          上一页
        </button>
        <button
          type="button"
          class={stylex.props(ui.button, ui.small).className}
          disabled={props.page >= pages()}
          onClick={() => props.onPage(props.page + 1)}
        >
          下一页
        </button>
      </div>
    </nav>
  );
}

export function AdminSearch(props: {
  value: string;
  onSearch: (value: string) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = createSignal(props.value);
  createEffect(() => setDraft(props.value));
  return (
    <form
      role="search"
      class={stylex.props(commonStyles.search).className}
      onSubmit={(event) => {
        event.preventDefault();
        props.onSearch(draft().trim());
      }}
    >
      <label class={stylex.props(commonStyles.searchLabel).className}>
        <span class={stylex.props(ui.label).className}>搜索记录</span>
        <input
          type="search"
          maxlength={100}
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          placeholder={props.placeholder ?? '输入名称或 ID'}
          class={stylex.props(ui.input).className}
        />
      </label>
      <button type="submit" class={stylex.props(ui.button, ui.small, ui.primary).className}>
        搜索
      </button>
      <Show when={props.value}>
        <button
          type="button"
          class={stylex.props(ui.button, ui.small).className}
          onClick={() => {
            setDraft('');
            props.onSearch('');
          }}
        >
          清除
        </button>
      </Show>
    </form>
  );
}

export function AdminUserLink(props: { id: string; name: string; exists?: boolean }) {
  return (
    <Show
      when={props.exists !== false}
      fallback={
        <span>
          {props.name}
          <span class={stylex.props(adminStyles.muted).className}> · 非用户席位</span>
        </span>
      }
    >
      <Link
        to="/admin/users/$userId"
        params={{ userId: props.id }}
        search={{ page: 1 }}
        class={stylex.props(adminStyles.link).className}
      >
        {props.name}
      </Link>
    </Show>
  );
}

export function AdminMatchLink(props: { id: string; label?: string }) {
  return (
    <Link
      to="/admin/matches/$matchId"
      params={{ matchId: props.id }}
      search={{}}
      class={stylex.props(adminStyles.link, adminStyles.mono).className}
    >
      {props.label ?? props.id}
    </Link>
  );
}

export function AdminBookLink(props: { theme: string }) {
  return (
    <Link
      to="/admin/books/$theme"
      params={{ theme: props.theme }}
      search={{ page: 1 }}
      class={stylex.props(adminStyles.link).className}
    >
      {props.theme}
    </Link>
  );
}
