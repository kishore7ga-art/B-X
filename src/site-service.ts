import { prisma } from "@/db";
import { OFFERABLE } from "@/library-service";

/**
 * The public reads: the template gallery, and one page of one college's site.
 *
 * These ran in the frontend against its own Prisma client. That is what made a
 * wrong `DATABASE_URL` on that service turn every published site into a 500
 * while this one reported itself perfectly healthy — the same database
 * configured twice, and only one copy right.
 *
 * Theme values come back raw, and section labels are absent, for the same
 * reason as the editor read: both are presentation, and the frontend already
 * owns the palette parser and the component registry.
 */

const VARIANT_ORDER = [
  { sortOrder: "asc" as const },
  { variantName: "asc" as const },
];

/**
 * The design gallery. Reference data — the same for every visitor.
 *
 * `OFFERABLE` is what makes the admin panel's publish and archive controls mean
 * something. Until it was added here this selected every row, so a half-assembled
 * template would have appeared in the gallery the moment it was created, and an
 * archived one never left it.
 */
export async function listTemplates() {
  const templates = await prisma.template.findMany({
    where: OFFERABLE,
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      description: true,
      thumbnailUrl: true,
      demoUrl: true,
      _count: { select: { sections: true } },
    },
  });

  return templates.map(({ _count, ...template }) => ({
    ...template,
    // Flattened: `_count.sections` is a Prisma detail, and the wire should not
    // carry the shape of the query that produced it.
    sectionCount: _count.sections,
  }));
}

/** One template, with every palette and font pack it can be paired with. */
export async function getTemplateDetail(templateId: string) {
  const [template, palettes, fonts] = await Promise.all([
    // findFirst, not findUnique: the offerable check is a filter, and a draft
    // template must answer "no such template" here rather than hand a college the
    // theme picker for something it is not allowed to start with.
    prisma.template.findFirst({
      where: { id: templateId, ...OFFERABLE },
      select: {
        id: true,
        name: true,
        description: true,
        thumbnailUrl: true,
        demoUrl: true,
        _count: { select: { sections: true } },
      },
    }),
    prisma.themePalette.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, colors: true },
    }),
    prisma.themeFont.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, headingFont: true, bodyFont: true },
    }),
  ]);

  if (!template) return null;

  const { _count, ...rest } = template;
  return {
    template: { ...rest, sectionCount: _count.sections },
    palettes,
    fonts,
  };
}

/**
 * Everything needed to render one page of one college's site.
 *
 * `viewerCollegeId` is the caller's own college, when they have a session. It
 * decides one thing: whether a draft is visible. Published sites are open to
 * everyone; a draft answers as absent to the public but renders for the college
 * that owns it, so the editor's "View site" works before anything is published.
 *
 * That check lives here rather than in the caller because it is an
 * authorisation rule about data, and the honest place for one of those is the
 * service that holds the data. Previously the frontend fetched the whole page
 * and then decided whether it was allowed to show it, which works right up
 * until something forgets to ask.
 */
export async function getSitePage(
  subdomain: string,
  pageSlug: string | undefined,
  viewerCollegeId: string | null,
) {
  const college = await prisma.college.findUnique({
    where: { subdomain },
    include: {
      themePalette: true,
      themeFont: true,
      pages: { orderBy: { navOrder: "asc" } },
    },
  });

  if (!college) return null;

  const isOwnerPreview = college.status !== "PUBLISHED";

  const currentPage = pageSlug
    ? college.pages.find((page) => page.slug === pageSlug)
    : college.pages[0];

  /**
   * A college with no pages is not a missing college.
   *
   * Two very different situations used to arrive at the caller as the same
   * `null`: a subdomain nobody owns, and a college one click away from being a
   * website. Only the first is a 404 — saying "not found" about the second is
   * both wrong and a dead end, so the frontend went back to the database to
   * tell them apart. Answering the question here is what lets that second query
   * go away.
   */
  if (!currentPage) {
    /**
     * Checked before draft visibility, which is deliberate and worth naming:
     * it means a college that has not built anything yet shows this to
     * everybody, including strangers, and so discloses its name. That is what
     * the frontend did before this moved, and relocating a behaviour is not the
     * moment to change one — but it is worth a decision of its own, because the
     * rule one line below is that drafts are invisible.
     */
    return {
      built: false as const,
      college: { name: college.name, subdomain: college.subdomain },
    };
  }

  if (isOwnerPreview && college.id !== viewerCollegeId) {
    // Absent rather than forbidden: to anyone who is not its owner, an
    // unpublished site is not a thing they are being refused, it is a thing
    // that does not exist yet.
    return null;
  }

  // Hidden sections are never served here. The editor gets those from
  // /api/v1/editor/:subdomain, which is behind a session.
  const rows = await prisma.collegeSection.findMany({
    where: {
      collegeId: college.id,
      pageId: currentPage.id,
      isVisible: true,
    },
    orderBy: { displayOrder: "asc" },
    include: { section: true, variant: true },
  });

  return {
    built: true as const,
    college: {
      id: college.id,
      name: college.name,
      subdomain: college.subdomain,
      status: college.status,
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
    },
    seo: {
      metaTitle: currentPage.metaTitle,
      metaDescription: currentPage.metaDescription,
      ogImage: currentPage.ogImage,
      canonicalSlug: currentPage.canonicalSlug,
    },
    sections: rows.map((row) => ({
      id: row.id,
      sectionType: row.section.sectionType,
      componentKey: row.variant.componentKey,
      variantId: row.variantId,
      variantName: row.variant.variantName,
      displayOrder: row.displayOrder,
      isVisible: row.isVisible,
      content: row.content,
    })),
    /** True when this render is a draft shown to its own college. */
    isOwnerPreview,
  };
}

export { VARIANT_ORDER };
