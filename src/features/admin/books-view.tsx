import { For, Show } from 'solid-js';
import { useQuery } from '@tanstack/solid-query';
import * as stylex from '@stylexjs/stylex';
import type { AdminBook, AdminListSearch, AdminPage } from '../../../shared/admin';
import { adminBooksOptions } from './queries';
import {
  AdminBookLink,
  AdminEmpty,
  AdminHeading,
  AdminPagination,
  AdminPanel,
  AdminQueryState,
  AdminSearch,
  formatDate,
  formatNumber,
} from './common';
import { adminStyles } from './admin.styles';
import { RefreshBadge } from './views.shared';

/**
 * 主题咒文书列表：当前缓存中的全部主题咒文书。
 * 每个主题始终链接到其详情页；列表中的每行都是真实存在的缓存条目。
 */
export function AdminBooksView(props: {
  search: () => AdminListSearch;
  onSearch: (updates: { q?: string; page?: number }) => void;
}) {
  const query = useQuery(() => adminBooksOptions(props.search()));
  return (
    <div class={stylex.props(adminStyles.stack).className} data-testid="view-admin-books">
      <AdminHeading
        title="咒文书管理"
        description="查看各主题当前缓存使用的咒文书内容，以及同一主题下的对局记录。"
      />
      <AdminQueryState query={query}>
        <Show when={query.data} keyed>
          {(data) => (
            <AdminPanel title="主题列表">
              <div class={stylex.props(adminStyles.toolbar).className}>
                <AdminSearch
                  value={props.search().q}
                  placeholder="搜索主题名称"
                  onSearch={(q) => props.onSearch({ q, page: 1 })}
                />
              </div>
              <BooksTable search={props.search} page={data} />
              <AdminPagination
                page={data.page}
                total={data.total}
                pageSize={data.pageSize}
                onPage={(page) => props.onSearch({ page })}
              />
            </AdminPanel>
          )}
        </Show>
      </AdminQueryState>
    </div>
  );
}

function BooksTable(props: { search: () => AdminListSearch; page: AdminPage<AdminBook> }) {
  return (
    <Show
      when={props.page.items.length > 0}
      fallback={
        <AdminEmpty>
          {props.search().q.length > 0
            ? '没有匹配的主题，请调整搜索关键词。'
            : '还没有缓存的咒文书。'}
        </AdminEmpty>
      }
    >
      <div class={stylex.props(adminStyles.tableWrap).className}>
        <table class={stylex.props(adminStyles.table).className} data-testid="admin-books-table">
          <thead>
            <tr>
              <th scope="col" class={stylex.props(adminStyles.th).className}>
                主题
              </th>
              <th scope="col" class={stylex.props(adminStyles.th).className}>
                咒文数
              </th>
              <th scope="col" class={stylex.props(adminStyles.th).className}>
                发布时间
              </th>
              <th scope="col" class={stylex.props(adminStyles.th).className}>
                刷新状态
              </th>
              <th scope="col" class={stylex.props(adminStyles.th).className}>
                关联对局
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={props.page.items}>
              {(book) => (
                <tr>
                  <td class={stylex.props(adminStyles.td).className}>
                    <AdminBookLink theme={book.theme} />
                  </td>
                  <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
                    {formatNumber(book.spellCount)}
                  </td>
                  <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
                    {formatDate(book.publishedAt)}
                  </td>
                  <td class={stylex.props(adminStyles.td).className}>
                    <RefreshBadge refreshing={book.refreshing} publishedAt={book.publishedAt} />
                  </td>
                  <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
                    {formatNumber(book.matchCount)}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </Show>
  );
}
