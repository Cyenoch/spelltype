import { For, Show } from 'solid-js';
import { useQuery } from '@tanstack/solid-query';
import * as stylex from '@stylexjs/stylex';
import type { AdminListSearch, AdminMatch, AdminPage } from '../../../shared/admin';
import { adminMatchesOptions } from './queries';
import {
  AdminEmpty,
  AdminHeading,
  AdminMatchLink,
  AdminPagination,
  AdminPanel,
  AdminQueryState,
  AdminSearch,
  formatDate,
  formatNumber,
} from './common';
import { adminStyles } from './admin.styles';
import { BookTheme, ModeText, OpponentBadge, PhaseBadge } from './views.shared';
import { PHASE_LABELS } from '../../ui/format';
import type { Phase } from '../../../shared/protocol';
import { ui } from '../../ui/primitives';
import { styles } from './views.styles';

/** 对局列表的阶段筛选项：与路由 `parseMatchPhase` 的白名单保持一致（不含大厅准备）。 */
const PHASE_FILTERS: readonly Phase[] = ['generating', 'countdown', 'playing', 'finished'];

export function AdminMatchesView(props: {
  search: () => AdminListSearch & { phase: string };
  onSearch: (updates: { q?: string; page?: number; phase?: string }) => void;
}) {
  const query = useQuery(() => adminMatchesOptions(props.search()));
  return (
    <div class={stylex.props(adminStyles.stack).className} data-testid="view-admin-matches">
      <AdminHeading
        title="对局管理"
        description="检索历史对局与进行中的房间；点击对局 ID 查看参与者、结算指标与咒文书快照。"
      />
      <AdminQueryState query={query}>
        <Show when={query.data} keyed>
          {(data) => (
            <AdminPanel title="对局列表">
              <div class={stylex.props(adminStyles.toolbar).className}>
                <div class={stylex.props(styles.filterRow).className}>
                  <AdminSearch
                    value={props.search().q}
                    placeholder="搜索对局 ID、房间 ID 或主题"
                    onSearch={(q) => props.onSearch({ q, page: 1 })}
                  />
                  <label class={stylex.props(styles.phaseFilter).className}>
                    <span class={stylex.props(ui.label).className}>阶段筛选</span>
                    <select
                      class={stylex.props(ui.input, ui.select).className}
                      data-testid="admin-matches-phase"
                      value={props.search().phase}
                      onChange={(event) =>
                        props.onSearch({ phase: event.currentTarget.value, page: 1 })
                      }
                    >
                      <option value="">全部阶段</option>
                      <For each={PHASE_FILTERS}>
                        {(phase) => <option value={phase}>{PHASE_LABELS[phase]}</option>}
                      </For>
                    </select>
                  </label>
                </div>
              </div>
              <MatchesTable search={props.search} page={data} />
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

function MatchesTable(props: {
  search: () => AdminListSearch & { phase: string };
  page: AdminPage<AdminMatch>;
}) {
  return (
    <Show
      when={props.page.items.length > 0}
      fallback={
        <AdminEmpty>
          {props.search().q.length > 0 || props.search().phase.length > 0
            ? '没有匹配的对局，请调整搜索关键词或阶段筛选。'
            : '还没有对局记录。'}
        </AdminEmpty>
      }
    >
      <div class={stylex.props(adminStyles.tableWrap).className}>
        <table class={stylex.props(adminStyles.table).className} data-testid="admin-matches-table">
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
                对手类型
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
            <For each={props.page.items}>{(match) => <MatchCells match={match} />}</For>
          </tbody>
        </table>
      </div>
    </Show>
  );
}

function MatchCells(props: { match: AdminMatch }) {
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
      <td class={stylex.props(adminStyles.td).className}>
        <OpponentBadge kind={props.match.opponentKind} />
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
