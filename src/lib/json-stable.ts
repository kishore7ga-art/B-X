/**
 * JSON with object keys in a fixed order, for comparing content to content.
 *
 * Postgres reorders jsonb keys on storage, so a value read back never
 * stringifies to what was written even when nothing changed. Anywhere that
 * asks "is this the same content?" has to normalise first or the answer is
 * always no.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);

  return `{${entries.join(",")}}`;
}
