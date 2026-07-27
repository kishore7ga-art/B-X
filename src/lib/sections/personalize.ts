import { stableStringify } from "@/lib/json-stable";

/**
 * The placeholder a template's starter copy carries where a college's own name
 * belongs.
 *
 * Templates ship the same words to everyone, so the name cannot be baked in —
 * a college that picked Radian used to open on "About Greenfield" and had to
 * find every mention itself.
 */
export const COLLEGE_NAME_TOKEN = "{{collegeName}}";

/** Substitutes the token throughout a content object, at any depth. */
export function personalize<T>(content: T, collegeName: string): T {
  if (typeof content === "string") {
    return content.split(COLLEGE_NAME_TOKEN).join(collegeName) as T;
  }

  if (Array.isArray(content)) {
    return content.map((item) => personalize(item, collegeName)) as T;
  }

  if (content && typeof content === "object") {
    return Object.fromEntries(
      Object.entries(content as Record<string, unknown>).map(([key, value]) => [
        key,
        personalize(value, collegeName),
      ]),
    ) as T;
  }

  return content;
}

/**
 * Is this section still exactly what the template provided?
 *
 * Compared against the starter copy personalised for *this* college, because
 * that is what was written into it — the raw token never reaches the database.
 * Anything else means somebody edited it, and edited words are never worth
 * overwriting to make sample copy read better.
 */
export function isUntouched(
  content: unknown,
  defaultContent: unknown,
  collegeName: string,
): boolean {
  if (defaultContent == null) return false;
  return (
    stableStringify(content) ===
    stableStringify(personalize(defaultContent, collegeName))
  );
}
