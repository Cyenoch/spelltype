/**
 * The history panel's TanStack Table wiring.
 *
 * The panel is client-side only: the API hands back one account's ten most recent records and the
 * table sorts, filters and pages exactly those rows. Nothing here re-queries the server, so every
 * column accessor reads the wire record directly.
 */
import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  metaHelper,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  type FilterFn,
  type SortFn,
} from '@tanstack/solid-table';
import type { MatchResult } from '../../../shared/protocol';
import {
  formatAccuracyPercent,
  formatAmount,
  formatTimestamp,
  OPPONENT_KIND_LABELS,
} from '../../ui/format';

/** The per-row cell attributes the retired table carried alongside the measured text. */
export interface HistoryCellAttrs {
  'data-damage'?: string;
  'data-hp'?: string;
}

/** Per-column hooks the retired table's DOM carried: cell testids, alignment and data attributes. */
export interface HistoryColumnMeta {
  /** The browser suite reads every measurement through these. */
  testid: string;
  /** Right-aligned numeric column with tabular figures. */
  num?: boolean;
  /** Extra attributes this column's cells carry, computed from the row. */
  attrs?: (result: MatchResult) => HistoryCellAttrs;
}

export const historyFeatures = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  columnMeta: metaHelper<HistoryColumnMeta>(),
});

/** The API window is ten rows, so one page holds the whole history until a smaller page is chosen. */
export const HISTORY_PAGE_SIZE = 10;
export const HISTORY_PAGE_SIZES = [5, 10, 25];

/** A search term matches a record's theme or its rendered timestamp. */
export const filterHistory: FilterFn<typeof historyFeatures, MatchResult> = (
  row,
  _columnId,
  filterValue,
) => {
  const needle = String(filterValue ?? '')
    .trim()
    .toLowerCase();
  if (needle.length === 0) return true;
  return (
    row.original.theme.toLowerCase().includes(needle) ||
    formatTimestamp(row.original.created_at).includes(needle)
  );
};

/** `null` accuracy is an unmeasured match, not a 0% one: unknowns sort below every measurement. */
const sortByAccuracy: SortFn<typeof historyFeatures, MatchResult> = (a, b) =>
  (a.original.accuracy ?? -1) - (b.original.accuracy ?? -1);

const helper = createColumnHelper<typeof historyFeatures, MatchResult>();

export const historyColumns = helper.columns([
  helper.accessor('created_at', {
    id: 'created',
    header: '时间',
    sortFn: sortFn_datetime,
    cell: (info) => formatTimestamp(info.getValue()),
    meta: { testid: 'history-created' },
  }),
  helper.accessor('theme', {
    header: '主题',
    sortFn: sortFn_text,
    cell: (info) => info.getValue(),
    meta: { testid: 'history-theme' },
  }),
  helper.accessor((row) => OPPONENT_KIND_LABELS[row.opponent_kind], {
    id: 'opponent',
    header: '对手',
    sortFn: sortFn_text,
    cell: (info) => info.getValue(),
    meta: { testid: 'history-opponent' },
  }),
  helper.accessor('rank', {
    header: '名次',
    // First place is the best place: the column's scale is inverted, not its values.
    sortFn: sortFn_basic,
    invertSorting: true,
    cell: (info) => `#${info.getValue()}`,
    meta: { testid: 'history-rank', num: true },
  }),
  helper.accessor('damage_dealt', {
    header: '造成伤害',
    sortFn: sortFn_basic,
    cell: (info) => formatAmount(info.getValue()),
    meta: {
      testid: 'history-damage',
      num: true,
      attrs: (result) => ({ 'data-damage': String(result.damage_dealt) }),
    },
  }),
  helper.accessor('hp_remaining', {
    header: '剩余生命',
    sortFn: sortFn_basic,
    cell: (info) => formatAmount(info.getValue()),
    meta: {
      testid: 'history-hp',
      num: true,
      attrs: (result) => ({ 'data-hp': String(result.hp_remaining) }),
    },
  }),
  helper.accessor('spells_cast', {
    header: '施法',
    sortFn: sortFn_basic,
    cell: (info) => String(info.getValue()),
    meta: { testid: 'history-spells', num: true },
  }),
  helper.accessor('cpm', {
    header: '字/分钟',
    sortFn: sortFn_basic,
    cell: (info) => String(info.getValue()),
    meta: { testid: 'history-cpm', num: true },
  }),
  helper.accessor('accuracy', {
    header: '准确率',
    sortFn: sortByAccuracy,
    cell: (info) => formatAccuracyPercent(info.getValue()),
    meta: { testid: 'history-accuracy', num: true },
  }),
  helper.accessor(
    (row) => {
      if (row.input_policy_version === 'legacy-unmeasured') return '旧记录：未测量';
      const ratio =
        row.input_min_completion_ratio === null
          ? '未采样'
          : row.input_min_completion_ratio.toFixed(2);
      return `${row.input_policy_version} · ${row.input_policy_mode === 'enforce' ? '执行' : '观察'} · 触及规则 ${row.input_gate_hits} 条 · 恢复 ${row.input_recoveries} 次 · 最小资格比值 ${ratio} · 连接超限 ${row.input_overloads} 次 · 非真人认证`;
    },
    {
      id: 'input-policy',
      header: '输入规则',
      enableSorting: false,
      cell: (info) => info.getValue(),
      meta: { testid: 'history-input-policy' },
    },
  ),
]);
