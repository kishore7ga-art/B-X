import { prisma } from "@/db";
import type { SectionType } from "@/generated/prisma/enums";

/**
 * The section design library, read once and grouped by type.
 *
 * Replaces the `include: { variants: … }` that used to hang off every template
 * slot. That worked because variants were stored per slot; now that they are
 * shared, "the designs available for this section" is a question about a section
 * *type*, not about one template's row — so it is answered once for the whole
 * request rather than joined five times.
 *
 * Ordering is the library's own: `sortOrder`, then name. Which design a template
 * *opens* with is a different question and lives on `Section.defaultVariantId`,
 * because that is a fact about the template rather than about the design.
 */

export const VARIANT_ORDER = [
  { sortOrder: "asc" as const },
  { variantName: "asc" as const },
];

export type LibraryVariant = {
  id: string;
  variantName: string;
  componentKey: string;
};

/**
 * Every offerable design, keyed by the section type it applies to.
 *
 * Retired variants are excluded — `isActive` is what stops the ↻ button and the
 * assembly screen offering something withdrawn. A college already using a retired
 * design keeps rendering it, because its `college_sections.variant_id` still
 * points at the row; it simply stops being somewhere new sites can land.
 */
export async function variantLibrary(): Promise<
  Map<SectionType, LibraryVariant[]>
> {
  const rows = await prisma.sectionVariant.findMany({
    where: { isActive: true },
    orderBy: VARIANT_ORDER,
    select: {
      id: true,
      sectionType: true,
      variantName: true,
      componentKey: true,
    },
  });

  const byType = new Map<SectionType, LibraryVariant[]>();
  for (const { sectionType, ...variant } of rows) {
    const list = byType.get(sectionType);
    if (list) list.push(variant);
    else byType.set(sectionType, [variant]);
  }
  return byType;
}

/**
 * Which design a template slot should open with.
 *
 * `defaultVariantId` first — that is the per-template choice the migration
 * preserved, and it is what keeps five templates looking like five templates. The
 * library's own order is the fallback for a slot that has never named one, which
 * is every slot an admin creates before picking a lead.
 */
export function leadVariant(
  slot: { sectionType: SectionType; defaultVariantId: string | null },
  library: Map<SectionType, LibraryVariant[]>,
): LibraryVariant | null {
  const available = library.get(slot.sectionType) ?? [];
  if (slot.defaultVariantId) {
    const named = available.find((v) => v.id === slot.defaultVariantId);
    if (named) return named;
    // Named a variant that has since been retired. Falling through to the
    // library's first is better than provisioning a site with no design at all.
  }
  return available[0] ?? null;
}
