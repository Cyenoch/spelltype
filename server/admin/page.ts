import type { AdminListSearch } from '../../shared/admin';

/** 管理端所有分页接口的固定页大小。 */
export const ADMIN_PAGE_SIZE = 20;

/**
 * 将搜索词转换为包含匹配的 ILIKE 模式。`%`、`_` 与 `\` 一律按字面值转义，
 * 因此调用方输入的通配符永远不会被解释为模式（PostgreSQL 默认转义符即反斜杠）。
 */
export function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

/** 供过滤条件构造使用的模式；空搜索词表示不加任何搜索条件。 */
export function searchPattern(search: AdminListSearch): string | null {
  return search.q.length > 0 ? containsPattern(search.q) : null;
}

/** 驱动会将 bigint/numeric 聚合值以字符串返回；统一收敛为 number，空缺视为 0。 */
export function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 可空的聚合值（avg 等）：null 表示未知，而非 0。 */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
