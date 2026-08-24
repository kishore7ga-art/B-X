/**
 * The section library, as a tenant sees it.
 *
 * The editor fetched `/api/v1/admin/templates` for this. That route requires an
 * **admin** session — a college's `college_session` cookie fails `requireAdmin`
 * — so in production the editor's template list was empty for every tenant,
 * every time. Everything downstream of it then behaved exactly as designed on
 * no data: the Add Section picker showed nineteen categories greyed out as "Not
 * in library", and Swap Variant found a cycle of length one and reported "Only
 * 1 variant — add more sections in Admin › Templates" no matter how many the
 * admin had added. That is the whole of "section swap does not fetch the
 * correct templates".
 *
 * This is the tenant-facing read of the same collection, and it differs from
 * the admin one in three ways that matter:
 *
 *  - archived and unpublished templates are excluded, so a tenant cannot be
 *    swapped into a draft the admin retired;
 *  - every row carries a resolved `category`, decided once here rather than
 *    re-guessed by three different heuristics in the browser;
 *  - the order is deterministic and stable across requests, because it is the
 *    order the swap cycle steps through, and a cycle whose order changes
 *    between two clicks is the "swap is unreliable" bug in its purest form.
 */

import { Template } from "@/models";
import { resolveCategory, UNCATEGORISED, type SectionCategoryId } from "@/lib/sections/categories";
import { sanitizeSectionHtml } from "@/lib/sections/sanitize-section-html";

export type LibrarySection = {
  id: string;
  name: string;
  /** One of the 19 canonical ids, or "custom". */
  category: SectionCategoryId | typeof UNCATEGORISED;
  description: string | null;
  thumbnailUrl: string | null;
  code: string;
};

export type SectionLibrary = {
  sections: LibrarySection[];
  /** category id -> that category's variants, in cycle order. */
  byCategory: Record<string, LibrarySection[]>;
};

/**
 * Two templates whose markup is identical after sanitising are one variant.
 *
 * The admin library accumulates near-duplicates — a template saved twice under
 * two names, or re-uploaded after an edit that changed nothing. Left in, they
 * make the swap cycle appear to do nothing for a click or two, which reads as a
 * broken button rather than as two identical variants.
 */
function dedupeKey(code: string): string {
  return code.replace(/\s+/g, " ").trim();
}

export async function getSectionLibrary(): Promise<SectionLibrary> {
  let rows: any[] = [];
  try {
    // Sorted in the database rather than in JS so the order does not depend on
    // how many documents happened to be returned. `_id` is the tiebreaker: it
    // is monotonic, unique and immutable, which makes the cycle order stable
    // across requests even for two templates sharing a name.
    rows = await Template.find({
      archivedAt: null,
      isPublished: true,
    }).sort({ category: 1, name: 1, _id: 1 });
  } catch {
    rows = [];
  }

  const sections: LibrarySection[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const rawCode = row.code ?? "";
    if (typeof rawCode !== "string" || !rawCode.trim()) continue;

    // Sanitised here, not at render. The editor injects this markup with
    // `dangerouslySetInnerHTML` the moment a variant is swapped in, and the
    // published site renders whatever that left behind.
    const code = sanitizeSectionHtml(rawCode);
    if (!code.trim()) continue;

    const key = dedupeKey(code);
    if (seen.has(key)) continue;
    seen.add(key);

    sections.push({
      id: row.id || row._id?.toString() || key.slice(0, 24),
      name: row.name || "Section",
      category: resolveCategory({
        category: row.category ?? null,
        name: row.name ?? null,
        code,
      }),
      description: row.description ?? null,
      thumbnailUrl: row.thumbnailUrl ?? null,
      code,
    });
  }

  const byCategory: Record<string, LibrarySection[]> = {};
  for (const section of sections) {
    (byCategory[section.category] ??= []).push(section);
  }

  return { sections, byCategory };
}
