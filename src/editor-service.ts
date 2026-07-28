import { prisma } from "@/db";
import type {
  CollegePayload,
  EditorPagePayload,
} from "@/lib/api-contract";
import { isSupportedSectionType } from "@/lib/sections/schemas";

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

const VARIANT_ORDER = [
  { sortOrder: "asc" as const },
  { variantName: "asc" as const },
];

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
        include: {
          sections: {
            orderBy: { defaultOrder: "asc" },
            include: { variants: { orderBy: VARIANT_ORDER } },
          },
        },
      },
      pages: { orderBy: { navOrder: "asc" } },
    },
  });

  if (!college) return null;

  const currentPage = pageSlug
    ? college.pages.find((page) => page.slug === pageSlug)
    : college.pages[0];

  if (!currentPage) return null;

  // Hidden sections are included — the editor must be able to switch them on.
  const rows = await prisma.collegeSection.findMany({
    where: { collegeId: college.id, pageId: currentPage.id },
    orderBy: { displayOrder: "asc" },
    include: {
      section: { include: { variants: { orderBy: VARIANT_ORDER } } },
      variant: true,
    },
  });

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
      variants: row.section.variants.map((variant) => ({
        id: variant.id,
        variantName: variant.variantName,
        componentKey: variant.componentKey,
      })),
    }));

  const addableSections = (college.template?.sections ?? [])
    .filter(
      (section) =>
        isSupportedSectionType(section.sectionType) &&
        section.variants.length > 0,
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
      templateName: college.template?.name ?? null,
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
    templateCount: await prisma.template.count(),
  };
}
