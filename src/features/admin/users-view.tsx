import { For, Show } from 'solid-js';
import { useQuery } from '@tanstack/solid-query';
import * as stylex from '@stylexjs/stylex';
import type { AdminListSearch, AdminPage, AdminUser } from '../../../shared/admin';
import { adminUsersOptions } from './queries';
import {
  AdminEmpty,
  AdminHeading,
  AdminPagination,
  AdminPanel,
  AdminQueryState,
  AdminSearch,
  AdminUserLink,
  formatDate,
} from './common';
import { adminStyles } from './admin.styles';
import { BanBadge, RoleBadge } from './views.shared';

export function AdminUsersView(props: {
  search: () => AdminListSearch;
  onSearch: (updates: { q?: string; page?: number }) => void;
}) {
  const query = useQuery(() => adminUsersOptions(props.search()));
  return (
    <div class={stylex.props(adminStyles.stack).className} data-testid="view-admin-users">
      <AdminHeading
        title="用户管理"
        description="按用户名或 ID 检索账号；点击用户名可查看角色、注册信息、封禁状态、战绩汇总与对局历史。"
      />
      <AdminQueryState query={query}>
        <Show when={query.data} keyed>
          {(data) => (
            <AdminPanel title="账号列表">
              <div class={stylex.props(adminStyles.toolbar).className}>
                <AdminSearch
                  value={props.search().q}
                  placeholder="搜索用户名或 ID"
                  onSearch={(q) => props.onSearch({ q, page: 1 })}
                />
              </div>
              <UsersTable search={props.search} page={data} />
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

function UsersTable(props: { search: () => AdminListSearch; page: AdminPage<AdminUser> }) {
  return (
    <Show
      when={props.page.items.length > 0}
      fallback={
        <AdminEmpty>
          {props.search().q.length > 0 ? '没有匹配的账号，请调整搜索关键词。' : '还没有账号注册。'}
        </AdminEmpty>
      }
    >
      <div class={stylex.props(adminStyles.tableWrap).className}>
        <table class={stylex.props(adminStyles.table).className} data-testid="admin-users-table">
          <thead>
            <tr>
              <th scope="col" class={stylex.props(adminStyles.th).className}>
                用户
              </th>
              <th scope="col" class={stylex.props(adminStyles.th).className}>
                用户 ID
              </th>
              <th scope="col" class={stylex.props(adminStyles.th).className}>
                角色
              </th>
              <th scope="col" class={stylex.props(adminStyles.th).className}>
                封禁
              </th>
              <th scope="col" class={stylex.props(adminStyles.th).className}>
                注册时间
              </th>
            </tr>
          </thead>
          <tbody>
            <For each={props.page.items}>
              {(user) => (
                <tr>
                  <td class={stylex.props(adminStyles.td).className}>
                    <AdminUserLink id={user.id} name={user.username} />
                  </td>
                  <td
                    class={
                      stylex.props(adminStyles.td, adminStyles.mono, adminStyles.muted).className
                    }
                  >
                    {user.id}
                  </td>
                  <td class={stylex.props(adminStyles.td).className}>
                    <RoleBadge role={user.role} />
                  </td>
                  <td class={stylex.props(adminStyles.td).className}>
                    <BanBadge ban={user.ban} />
                  </td>
                  <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
                    {formatDate(user.createdAt)}
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
