/**
 * Narrow probes for the request schemas in `shared/validation.ts`.
 *
 * The unit tests read a schema's *outcome* — the normalized value, or a rejection — instead of
 * re-implementing its rules, so both the routes and the tests are judged by the same contract.
 */
interface SchemaProbe {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}

/** The parsed string, or `null` when the schema rejected the input. */
export function parsedString(schema: SchemaProbe, value: unknown): string | null {
  const result = schema.safeParse(value);
  return result.success && typeof result.data === 'string' ? result.data : null;
}

/** Whether the schema rejected the input. */
export function rejected(schema: SchemaProbe, value: unknown): boolean {
  return !schema.safeParse(value).success;
}
