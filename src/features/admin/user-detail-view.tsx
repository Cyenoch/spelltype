import { adminStyles } from './admin.styles';
import { For, Show } from 'solid-js';
import { useQuery } from '@tanstack/solid-query';
import * as stylex from '@stylexjs/stylex';
import type { AdminResult, AdminUserDetail } from '../../../shared/admin';
import { adminUserOptions } from './queries';
import {
  AdminEmpty,
  AdminHeading,
  AdminMatchLink,
  AdminPagination,
  AdminPanel,
  AdminQueryState,
  AdminStat,
  formatDate,
  formatNumber,
  formatPercent,
} from './common';
import {
  BookTheme,
  DetailItem,
  OpponentBadge,
  PhaseBadge,
  RankBadge,
  RoleBadge,
} from './views.shared';
import { formatAmount, formatDuration } from '../../ui/format';

/**
 * 账号详情：注册信息与会话概况、全部战绩汇总、当前所在房间，
 * 以及服务端分页的对局历史（含名次、准确率、CPM、伤害、施法与用时）。
 */
export function AdminUserDetailView(props: {
  userId: () => string;
  page: () => number;
  onPage: (page: number) => void;
}) {
  const query = useQuery(() => adminUserOptions(props.userId(), props.page()));
  return (
    <div class={stylex.props(adminStyles.stack).className} data-testid="view-admin-user-detail">
      <AdminQueryState query={query}>
        <Show when={query.data} keyed>
          {(data) => (
            <>
              <AdminHeading
                title={data.user.username}
                description="账号的注册信息、战绩汇总与对局历史。"
              />
              <UserDetailBody data={data} onPage={props.onPage} />
            </>
          )}
        </Show>
      </AdminQueryState>
    </div>
  );
}

function UserDetailBody(props: { data: AdminUserDetail; onPage: (page: number) => void }) {
  const stats = props.data.stats;
  const statTiles = [
    { key: 'games', label: '完成对局', value: formatNumber(stats.games) },
    { key: 'wins', label: '胜场（第 1 名）', value: formatNumber(stats.wins) },
    { key: 'bestCpm', label: '最佳速度 · 字/分', value: formatNumber(stats.bestCpm) },
    { key: 'averageCpm', label: '平均速度 · 字/分', value: formatNumber(stats.averageCpm) },
    { key: 'averageAccuracy', label: '平均准确率', value: formatPercent(stats.averageAccuracy) },
    { key: 'damageDealt', label: '累计伤害', value: formatNumber(stats.damageDealt) },
    { key: 'spellsCast', label: '累计施法', value: formatNumber(stats.spellsCast) },
    { key: 'correctChars', label: '正确字符', value: formatNumber(stats.correctChars) },
    { key: 'durationMs', label: '累计战斗时长', value: formatDuration(stats.durationMs) },
    { key: 'lastPlayedAt', label: '最近对局', value: formatDate(stats.lastPlayedAt) },
  ] as const;
  return (
    <>
      <AdminPanel title="账号信息">
        <dl class={stylex.props(adminStyles.details).className} data-testid="admin-user-info">
          <DetailItem label="用户名">{props.data.user.username}</DetailItem>
          <DetailItem label="用户 ID">
            <span class={stylex.props(adminStyles.mono).className}>{props.data.user.id}</span>
          </DetailItem>
          <DetailItem label="角色">
            <RoleBadge role={props.data.user.role} />
          </DetailItem>
          <DetailItem label="注册时间">
            <span class={stylex.props(adminStyles.mono).className}>
              {formatDate(props.data.user.createdAt)}
            </span>
          </DetailItem>
          <DetailItem label="活跃会话">{formatNumber(props.data.activeSessions)}</DetailItem>
          <DetailItem label="归档幻影轨迹">{formatNumber(props.data.ghostCount)}</DetailItem>
        </dl>
      </AdminPanel>

      <AdminPanel title="战绩汇总">
        <div class={stylex.props(adminStyles.grid).className} data-testid="admin-user-stats">
          <For each={statTiles}>
            {(tile) => <AdminStat label={tile.label} value={tile.value} />}
          </For>
        </div>
      </AdminPanel>

      <AdminPanel title="当前房间">
        <Show
          when={props.data.activeRoom}
          fallback={
            <p class={stylex.props(adminStyles.muted).className}>该账号当前不在任何房间中。</p>
          }
          keyed
        >
          {(room) => (
            <dl class={stylex.props(adminStyles.details).className} data-testid="admin-user-room">
              <DetailItem label="房间 ID">
                <span class={stylex.props(adminStyles.mono).className}>{room.roomId}</span>
              </DetailItem>
              <DetailItem label="对局">
                <Show
                  when={room.matchId}
                  fallback={
                    <span class={stylex.props(adminStyles.muted).className}>尚未开始对局</span>
                  }
                  keyed
                >
                  {(matchId) => <AdminMatchLink id={matchId} />}
                </Show>
              </DetailItem>
              <DetailItem label="阶段">
                <PhaseBadge phase={room.phase} />
              </DetailItem>
              <DetailItem label="主题">
                <BookTheme theme={room.theme} />
              </DetailItem>
            </dl>
          )}
        </Show>
      </AdminPanel>

      <AdminPanel title="对局历史">
        <AdminPagination
          page={props.data.history.page}
          total={props.data.history.total}
          pageSize={props.data.history.pageSize}
          onPage={props.onPage}
        />
        <Show
          when={props.data.history.items.length > 0}
          fallback={<AdminEmpty>该账号还没有已保存的对局记录。</AdminEmpty>}
        >
          <div class={stylex.props(adminStyles.tableWrap).className}>
            <table
              class={stylex.props(adminStyles.table).className}
              data-testid="admin-user-history"
            >
              <thead>
                <tr>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    对局
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    名次
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    主题
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    对手类型
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    速度 · 字/分
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    准确率
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    伤害
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    施法
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    用时
                  </th>
                  <th scope="col" class={stylex.props(adminStyles.th).className}>
                    记录时间
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={props.data.history.items}>
                  {(result) => <HistoryCells result={result} />}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </AdminPanel>
    </>
  );
}

/** 历史表格的一行；准确率未知（账号无被计数击键）时如实显示「—」。 */
function HistoryCells(props: { result: AdminResult }) {
  return (
    <tr>
      <td class={stylex.props(adminStyles.td).className}>
        <AdminMatchLink id={props.result.match_id} />
      </td>
      <td class={stylex.props(adminStyles.td).className}>
        <RankBadge rank={props.result.rank} />
      </td>
      <td class={stylex.props(adminStyles.td).className}>
        <BookTheme theme={props.result.theme} />
      </td>
      <td class={stylex.props(adminStyles.td).className}>
        <OpponentBadge kind={props.result.opponent_kind} />
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatNumber(props.result.cpm)}
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatPercent(props.result.accuracy)}
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatAmount(props.result.damage_dealt)}
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatNumber(props.result.spells_cast)}
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatDuration(props.result.duration_ms)}
      </td>
      <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
        {formatDate(props.result.created_at)}
      </td>
    </tr>
  );
}
