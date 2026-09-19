/**
 * 历史战绩面板的 TanStack Table 适配逻辑。
 *
 * 该面板完全在客户端运行：API 返回单个账户最近的 10 条战绩记录，
 * 表格直接对这些数据行进行排序、过滤和分页。此处不向服务端发起二次查询，
 * 每一列的取值函数（accessor）直接读取网络传输的原始数据记录。
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

/** 已废弃表格在测量文本外所携带的单行单元格数据属性。 */
export interface HistoryCellAttrs {
  'data-damage'?: string;
  'data-hp'?: string;
}

/** 原表格 DOM 所携带的单列扩展钩子：单元格 testid、对齐方式以及数据属性。 */
export interface HistoryColumnMeta {
  /** 浏览器端测试套件据此读取每项测量数据。 */
  testid: string;
  /** 包含等宽数字的靠右对齐数值列。 */
  num?: boolean;
  /** 本列单元格携带的附加属性，根据当前行数据计算得出。 */
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

/** API 默认返回 10 条记录，因此在用户选择更小分页前，单页即可容纳全部历史。 */
export const HISTORY_PAGE_SIZE = 10;
export const HISTORY_PAGE_SIZES = [5, 10, 25];

/** 搜索词可匹配战绩的主题或其格式化后的时间戳。 */
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

/** 命中率为 `null` 代表未测量该局，而非 0%：未测量的记录排在所有测得的数据之后。 */
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
    // 第一名为最佳名次：反转该列的排序方向，而非改变数值大小。
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
