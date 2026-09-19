/**
 * 针对 `shared/validation.ts` 中请求 schema 的窄探针。
 *
 * 单元测试读取 schema 的*结果* —— 归一化后的值，或者一次拒绝 —— 而不是重新实现它的规则，
 * 这样路由和测试就由同一份契约来评判。
 */
interface SchemaProbe {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

/** 解析后的字符串；schema 拒绝输入时返回 `null`。 */
export function parsedString(schema: SchemaProbe, value: unknown): string | null {
  const result = schema.safeParse(value);
  return result.success && typeof result.data === 'string' ? result.data : null;
}

/** schema 是否拒绝了输入。 */
export function rejected(schema: SchemaProbe, value: unknown): boolean {
  return !schema.safeParse(value).success;
}
