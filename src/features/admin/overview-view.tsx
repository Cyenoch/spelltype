import { For, Show } from 'solid-js';
import { useQuery } from '@tanstack/solid-query';
import * as stylex from '@stylexjs/stylex';
import type { AdminMatch, AdminOverview, AdminUser } from '../../../shared/admin';
import { adminOverviewOptions } from './queries';
import {
  AdminEmpty,
  AdminHeading,
  AdminMatchLink,
  AdminPanel,
  AdminQueryState,
  AdminStat,
  AdminUserLink,
  formatDate,
  formatNumber,
} from './common';
import { adminStyles } from './admin.styles';
import { BookTheme, ModeText, PhaseBadge, RoleBadge } from './views.shared';

/**
 * 后台总览：六个全站计数，以及最近注册的账号与最近创建的对局。
 * 只读快照，不在本页提供任何修改操作；细节数据一律通过行内链接跳转到对应详情页。
 */
export function AdminOverviewView() {
  const query = useQuery(() => adminOverviewOptions());
  return (
    <div class={stylex.props(adminStyles.stack).className} data-testid="view-admin-overview">
      <AdminHeading
        title="后台总览"
        description="全站账号、对局与主题咒文书的数据概况。计数为当前时刻的快照，明细请进入各管理页查看。"
      />
      <AdminQueryState query={query}>
        <Show when={query.data} keyed>
          {(data) => <OverviewBody data={data} />}
        </Show>
      </AdminQueryState>
    </div>
  );
}

function OverviewBody(props: { data: AdminOverview }) {
  const counts = [
    { key: 'users', label: '注册账号', value: props.data.users },
    { key: 'admins', label: '管理员', value: props.data.admins },
    { key: 'matches', label: '对局总数', value: props.data.matches },
    { key: 'activeMatches', label: '进行中对局', value: props.data.activeMatches },
    { key: 'books', label: '主题咒文书', value: props.data.books },
    { key: 'ghosts', label: '归档幻影轨迹', value: props.data.ghosts },
  ] as const;
  return (
    <>
      <div class={stylex.props(adminStyles.grid).className} data-testid="admin-overview-counts">
        <For each={counts}>
          {(count) => <AdminStat label={count.label} value={formatNumber(count.value)} />}
        </For>
      </div>

      <AdminPanel title={`最近注册 · ${props.data.recentUsers.length} 人`}>
        <Show
          when={props.data.recentUsers.length > 0}
          fallback={<AdminEmpty>还没有账号注册。</AdminEmpty>}
        >
          <div class={stylex.props(adminStyles.tableWrap).className}>
            <table
              class={stylex.props(adminStyles.table).className}
              data-testid="admin-overview-users"
            >
              <thead>
                <tr>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    用户
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    角色
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    注册时间
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={props.data.recentUsers}>{(user) => <RecentUserCells user={user} />}</For>
              </tbody>
            </table>
          </div>
        </Show>
      </AdminPanel>

      <AdminPanel title={`最近对局 · ${props.data.recentMatches.length} 场`}>
        <Show
          when={props.data.recentMatches.length > 0}
          fallback={<AdminEmpty>还没有对局记录。</AdminEmpty>}
        >
          <div class={stylex.props(adminStyles.tableWrap).className}>
            <table
              class={stylex.props(adminStyles.table).className}
              data-testid="admin-overview-matches"
            >
              <thead>
                <tr>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    对局
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    主题
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    阶段
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    模式
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    参与者
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    记录时间
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={props.data.recentMatches}>
                  {(match) => <RecentMatchCells match={match} />}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </AdminPanel>
    </>
  );
}

/** 最近注册表格的一行；道具组件仅用于拆分行内 JSX，无独立状态。 */
function RecentUserCells(props: { user: AdminUser }) {
  return (
    <tr>
      <td class={stylex.props(adminStyles.td).className}>
        <AdminUserLink id={props.user.id} name={props.user.username} />
      </td>
      <td class={stylex.props(adminStyles.td).className}>
        <RoleBadge role={props.user.role} />
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatDate(props.user.createdAt)}
      </td>
    </tr>
  );
}

function RecentMatchCells(props: { match: AdminMatch }) {
  return (
    <tr>
      <td class={stylex.props(adminStyles.td).className}>
        <AdminMatchLink id={props.match.id} />
      </td>
      <td class={stylex.props(adminStyles.td).className}>
        <BookTheme theme={props.match.theme} />
      </td>
      <td class={stylex.props(adminStyles.td).className}>
        <PhaseBadge phase={props.match.phase} />
      </td>
      <td class={stylex.props(adminStyles.td).className}>
        <ModeText mode={props.match.mode} />
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatNumber(props.match.participantCount)}
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatDate(props.match.createdAt)}
      </td>
    </tr>
  );
}
