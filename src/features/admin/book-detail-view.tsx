import { For, Show } from 'solid-js';
import { useQuery } from '@tanstack/solid-query';
import * as stylex from '@stylexjs/stylex';
import type { AdminBookDetail, AdminMatch, AdminPage } from '../../../shared/admin';
import { adminBookOptions } from './queries';
import {
  AdminEmpty,
  AdminHeading,
  AdminMatchLink,
  AdminPagination,
  AdminPanel,
  AdminQueryState,
  formatDate,
  formatNumber,
} from './common';
import { adminStyles } from './admin.styles';
import {
  DetailItem,
  ModeText,
  OpponentBadge,
  PhaseBadge,
  RefreshBadge,
  SpellList,
} from './views.shared';

/**
 * 主题咒文书详情：当前缓存版本的完整有序咒文列表，以及同主题对局。
 * 关联对局仅按主题匹配，不保证使用与本页相同的咒文书版本。
 */
export function AdminBookDetailView(props: {
  theme: () => string;
  page: () => number;
  onPage: (page: number) => void;
}) {
  const query = useQuery(() => adminBookOptions(props.theme(), props.page()));
  return (
    <div class={stylex.props(adminStyles.stack).className} data-testid="view-admin-book-detail">
      <AdminQueryState query={query}>
        <Show when={query.data} keyed>
          {(data) => (
            <>
              <AdminHeading
                title={data.book.theme}
                description="该主题当前缓存使用的咒文书内容，以及同主题的对局记录。"
              />
              <BookDetailBody data={data} onPage={props.onPage} />
            </>
          )}
        </Show>
      </AdminQueryState>
    </div>
  );
}

function BookDetailBody(props: { data: AdminBookDetail; onPage: (page: number) => void }) {
  return (
    <>
      <AdminPanel title="咒文书信息">
        <dl class={stylex.props(adminStyles.details).className} data-testid="admin-book-info">
          <DetailItem label="主题">
            <span class={stylex.props(adminStyles.mono).className}>{props.data.book.theme}</span>
          </DetailItem>
          <DetailItem label="咒文数">{formatNumber(props.data.book.spellCount)}</DetailItem>
          <DetailItem label="发布时间">
            <span class={stylex.props(adminStyles.mono).className}>
              {formatDate(props.data.book.publishedAt)}
            </span>
          </DetailItem>
          <DetailItem label="刷新状态">
            <RefreshBadge
              refreshing={props.data.book.refreshing}
              publishedAt={props.data.book.publishedAt}
            />
          </DetailItem>
          <DetailItem label="关联对局">{formatNumber(props.data.book.matchCount)}</DetailItem>
        </dl>
      </AdminPanel>

      <AdminPanel title={`咒文内容 · ${props.data.spells.length} 条`}>
        <Show
          when={props.data.spells.length > 0}
          fallback={<AdminEmpty>该咒文书暂未包含咒文。</AdminEmpty>}
        >
          <SpellList spells={props.data.spells} />
        </Show>
      </AdminPanel>

      <AdminPanel title="关联对局">
        <p class={stylex.props(adminStyles.muted).className}>
          以下为同主题对局。咒文书按主题缓存并会不定期刷新：较早已保存的对局可能使用旧版本的咒文，
          与上方当前内容不完全一致。
        </p>
        <AdminPagination
          page={props.data.matches.page}
          total={props.data.matches.total}
          pageSize={props.data.matches.pageSize}
          onPage={props.onPage}
        />
        <BookMatchesTable page={props.data.matches} />
      </AdminPanel>
    </>
  );
}

function BookMatchesTable(props: { page: AdminPage<AdminMatch> }) {
  return (
    <Show
      when={props.page.items.length > 0}
      fallback={<AdminEmpty>该主题还没有对局记录。</AdminEmpty>}
    >
      <div class={stylex.props(adminStyles.tableWrap).className}>
        <table class={stylex.props(adminStyles.table).className} data-testid="admin-book-matches">
          <thead>
            <tr>
              <th scope="col" class={stylex.props(adminStyles.th).className}>
                对局
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
            <For each={props.page.items}>
              {(match) => (
                <tr>
                  <td class={stylex.props(adminStyles.td).className}>
                    <AdminMatchLink id={match.id} />
                  </td>
                  <td class={stylex.props(adminStyles.td).className}>
                    <PhaseBadge phase={match.phase} />
                  </td>
                  <td class={stylex.props(adminStyles.td).className}>
                    <ModeText mode={match.mode} />
                  </td>
                  <td class={stylex.props(adminStyles.td).className}>
                    <OpponentBadge kind={match.opponentKind} />
                  </td>
                  <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
                    {formatNumber(match.participantCount)}
                  </td>
                  <td class={stylex.props(adminStyles.td, adminStyles.mono).className}>
                    {formatDate(match.createdAt)}
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
