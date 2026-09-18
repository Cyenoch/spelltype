import { For, Show } from 'solid-js';
import { createTable, FlexRender } from '@tanstack/solid-table';
import * as stylex from '@stylexjs/stylex';
import type { MatchResult } from '../../../shared/protocol';
import { formatDuration } from '../../ui/format';
import { ui } from '../../ui/primitives';
import { styles } from './profile-view.styles';
import {
  HISTORY_PAGE_SIZE,
  HISTORY_PAGE_SIZES,
  filterHistory,
  historyColumns,
  historyFeatures,
} from './profile-view.table';
import type { HistoryCellAttrs } from './profile-view.table';

const NO_ATTRS: HistoryCellAttrs = {};

/**
 * The history window the API returned for one account: sorting, filtering and
 * paging happen in the browser over exactly those rows, so nothing here
 * re-queries the server.
 */
export function ProfileHistory(props: { history: MatchResult[] }) {
  const table = createTable({
    features: historyFeatures,
    columns: historyColumns,
    get data() {
      return props.history;
    },
    globalFilterFn: filterHistory,
    initialState: { pagination: { pageIndex: 0, pageSize: HISTORY_PAGE_SIZE } },
  });

  const emptyMessage = () =>
    props.history.length === 0 ? '还没有已保存的对局，先去打一局吧。' : '没有匹配的对局。';

  return (
    <>
      <Show when={props.history.length > 0}>
        <div class={stylex.props(styles.toolbar).className}>
          <div class={stylex.props(styles.filterBox).className}>
            <label class={stylex.props(ui.label).className} for="history-filter">
              筛选记录
            </label>
            <input
              id="history-filter"
              type="search"
              class={stylex.props(ui.input, styles.toolbarControl).className}
              data-testid="profile-history-filter"
              placeholder="主题或时间，例如：图书馆 / 09-18"
              value={String(table.atoms.globalFilter.get() ?? '')}
              onInput={(event) => table.setGlobalFilter(event.currentTarget.value)}
            />
          </div>
          <div class={stylex.props(styles.pagination).className}>
            <button
              type="button"
              class={stylex.props(ui.button, ui.small, styles.toolbarControl).className}
              data-testid="profile-history-prev"
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
            >
              上一页
            </button>
            <span
              class={stylex.props(ui.smallText, ui.faint).className}
              data-testid="profile-history-page"
            >
              第 {table.atoms.pagination.get().pageIndex + 1} / {Math.max(1, table.getPageCount())}{' '}
              页
            </span>
            <button
              type="button"
              class={stylex.props(ui.button, ui.small, styles.toolbarControl).className}
              data-testid="profile-history-next"
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
            >
              下一页
            </button>
            <div class={stylex.props(styles.pageSizeGroup).className}>
              <label
                class={stylex.props(ui.label, styles.inlineLabel).className}
                for="history-page-size"
              >
                每页
              </label>
              <select
                id="history-page-size"
                class={
                  stylex.props(ui.input, ui.select, styles.pageSize, styles.toolbarControl)
                    .className
                }
                data-testid="profile-history-page-size"
                value={String(table.atoms.pagination.get().pageSize)}
                onChange={(event) => table.setPageSize(Number(event.currentTarget.value))}
              >
                <For each={HISTORY_PAGE_SIZES}>
                  {(size) => <option value={size}>{size}</option>}
                </For>
              </select>
            </div>
          </div>
        </div>
      </Show>

      <div class={stylex.props(ui.resultsWrap).className}>
        <table class={stylex.props(ui.table).className} data-testid="profile-history">
          <thead>
            <For each={table.getHeaderGroups()}>
              {(headerGroup) => (
                <tr>
                  <For each={headerGroup.headers}>
                    {(header) => (
                      <th
                        class={
                          stylex.props(ui.th, header.column.columnDef.meta?.num ? ui.num : null)
                            .className
                        }
                        aria-sort={
                          header.column.getIsSorted() === 'asc'
                            ? 'ascending'
                            : header.column.getIsSorted() === 'desc'
                              ? 'descending'
                              : 'none'
                        }
                      >
                        <Show when={!header.isPlaceholder}>
                          <button
                            type="button"
                            class={stylex.props(styles.sortButton).className}
                            onClick={header.column.getToggleSortingHandler()}
                            disabled={!header.column.getCanSort()}
                          >
                            <FlexRender header={header} />
                            <span
                              class={stylex.props(styles.sortMark).className}
                              aria-hidden="true"
                            >
                              {header.column.getIsSorted() === 'asc'
                                ? '▲'
                                : header.column.getIsSorted() === 'desc'
                                  ? '▼'
                                  : ''}
                            </span>
                          </button>
                        </Show>
                      </th>
                    )}
                  </For>
                </tr>
              )}
            </For>
          </thead>
          <tbody>
            <Show
              when={table.getRowModel().rows.length > 0}
              fallback={
                <tr>
                  <td
                    class={stylex.props(ui.td, ui.muted).className}
                    colspan={historyColumns.length}
                  >
                    {emptyMessage()}
                  </td>
                </tr>
              }
            >
              <For each={table.getRowModel().rows}>
                {(row) => (
                  <tr
                    data-testid="history-row"
                    data-match-id={row.original.match_id}
                    title={`战斗时长 ${formatDuration(row.original.duration_ms)} · 正确字符 ${row.original.correct_chars}`}
                  >
                    <For each={row.getAllCells()}>
                      {(cell) => (
                        <td
                          class={
                            stylex.props(ui.td, cell.column.columnDef.meta?.num ? ui.num : null)
                              .className
                          }
                          data-testid={cell.column.columnDef.meta?.testid}
                          {...(cell.column.columnDef.meta?.attrs?.(row.original) ?? NO_ATTRS)}
                        >
                          <FlexRender cell={cell} />
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </Show>
          </tbody>
        </table>
      </div>
    </>
  );
}
