import { prisma } from "@/db";
import type {
  CollegePayload,
  EditorPagePayload,
} from "@/lib/api-contract";
import { isSupportedSectionType } from "@/lib/sections/schemas";
import { OFFERABLE } from "@/library-service";
import { variantLibrary } from "@/variant-library";

/**
 * The reads behind the two screens you land on after signing in.
 *
 * These ran in the frontend against its own `DATABASE_URL`, which meant the
 * same database was configured twice and either copy could be wrong on its own.
 * One was, for a day: sign-in succeeded against this service and every page
 * after it failed against the other. Served from here there is one credential,
 * in one place, and a frontend that cannot be misconfigured into this.
 *
 * Theme values come back raw — the palette's JSON, the font names — and section
 * labels are absent. Both are presentation, the frontend already owns them, and
 * neither is worth a tenth file kept in sync by hand across two repos.
 */

// VARIANT_ORDER moved to variant-library.ts with the designs themselves — the
// order is a property of the library, not of the two services that read it.

/**
 * The signed-in college, as the guarded pages need it.
 *
 * The return type is the shared contract rather than whatever the `select`
 * happens to produce, so removing a field here stops compiling instead of
 * quietly reaching the frontend as `undefined`.
 */
export async function getCollege(
  collegeId: string,
): Promise<CollegePayload | null> {
  const college = await prisma.college.findUnique({
    where: { id: collegeId },
    select: {
      id: true,
      name: true,
      subdomain: true,
      customDomain: true,
      templateId: true,
      themePaletteId: true,
      themeFontId: true,
      status: true,
      collegeType: true,
      isDemo: true,
      createdAt: true,
    },
  });

  if (!college) return null;

  // Serialised here rather than left to res.json's own Date handling — the
  // contract says string, so the conversion belongs where it can be checked.
  return { ...college, createdAt: college.createdAt.toISOString() };
}

export async function getEditorPage(
  subdomain: string,
  pageSlug?: string,
): Promise<EditorPagePayload | null> {
  const college = await prisma.college.findUnique({
    where: { subdomain },
    include: {
      themePalette: true,
      themeFont: true,
      template: {
        include: { sections: { orderBy: { defaultOrder: "asc" } } },
      },
      pages: { orderBy: { navOrder: "asc" } },
    },
  });

  if (!college) return null;

  const offerableTemplate =
    college.template &&
    college.template.isPublished &&
    college.template.archivedAt === null
      ? college.template
      : null;

  const currentPage = pageSlug
    ? college.pages.find((page) => page.slug === pageSlug)
    : college.pages[0];

  if (!currentPage) return null;

  // Hidden sections are included — the editor must be able to switch them on.
  const rows = await prisma.collegeSection.findMany({
    where: { collegeId: college.id, pageId: currentPage.id },
    orderBy: { displayOrder: "asc" },
    include: { section: true, variant: true },
  });

  // One read for the whole library, then looked up per row. The alternative is a
  // join per section, which is what this used to be when variants were per slot.
  const library = await variantLibrary();

  const sections = rows
    .filter((row) => isSupportedSectionType(row.section.sectionType))
    .map((row) => ({
      id: row.id,
      sectionId: row.sectionId,
      sectionType: row.section.sectionType,
      variantId: row.variantId,
      componentKey: row.variant.componentKey,
      variantName: row.variant.variantName,
      displayOrder: row.displayOrder,
      isVisible: row.isVisible,
      content: row.content,
      lastSavedAt: row.lastSavedAt?.toISOString() ?? null,
      // Every design of this type, from the shared library — which is what the
      // old per-slot include was already trying to approximate.
      variants: library.get(row.section.sectionType) ?? [],
    }));

  const addableSections = (offerableTemplate?.sections ?? [])
    .filter(
      (section) =>
        isSupportedSectionType(section.sectionType) &&
        (library.get(section.sectionType)?.length ?? 0) > 0,
    )
    .map((section) => ({
      sectionId: section.id,
      sectionType: section.sectionType,
    }));

  return {
    college: {
      id: college.id,
      name: college.name,
      subdomain: college.subdomain,
      status: college.status,
      templateName: offerableTemplate?.name ?? null,
    },
    theme: {
      paletteColors: college.themePalette?.colors ?? null,
      headingFont: college.themeFont?.headingFont ?? null,
      bodyFont: college.themeFont?.bodyFont ?? null,
    },
    pages: college.pages.map(({ id, slug, title }) => ({ id, slug, title })),
    currentPage: {
      id: currentPage.id,
      slug: currentPage.slug,
      title: currentPage.title,
      metaTitle: currentPage.metaTitle,
      metaDescription: currentPage.metaDescription,
      ogImage: currentPage.ogImage,
      canonicalSlug: currentPage.canonicalSlug,
    },
    sections,
    addableSections,
    // The editor only asks whether there is more than one design to cycle
    // through, so the count travels with the payload instead of a second call.
    templateCount: await prisma.template.count({ where: OFFERABLE }),
  };
}
