import { z } from "zod";

import { prisma } from "@/db";
import { defaultContentFor } from "@/lib/sections/defaults";
import { personalize } from "@/lib/sections/personalize";
import { isSupportedSectionType } from "@/lib/sections/schemas";
import { DEFAULT_PAGES } from "@/lib/site/starter";
import { BadRequest, NotFound } from "@/sections-service";

/**
 * Choosing a design, and what that does to a college's site.
 *
 * These were Server Actions in the frontend, writing to Postgres over its own
 * connection. Every one of them is a write the API should own — and while they
 * lived there, a wrong `DATABASE_URL` on that service meant picking a template
 * failed while this one looked perfectly healthy.
 *
 * The tenant is never taken from the request. Each function receives the
 * collegeId the session resolved to, and every query is scoped by it.
 */

const VARIANT_ORDER = [
  { sortOrder: "asc" as const },
  { variantName: "asc" as const },
];

export const startWithDesignSchema = z.object({
  templateId: z.string().min(1, "templateId is required"),
  paletteId: z.string().min(1, "paletteId is required"),
  fontId: z.string().min(1, "fontId is required"),
});

type TemplateSection = {
  id: string;
  sectionType: string;
  defaultContent: unknown;
  variants: { id: string }[];
};

/**
 * Starter copy for a section: the template's own, falling back to the generic
 * stub only for a template seeded before default_content existed.
 */
function starterContent(
  section: { sectionType: string; defaultContent?: unknown },
  collegeName: string,
) {
  const starter =
    (section.defaultContent as object | null) ??
    defaultContentFor(section.sectionType as never, collegeName);

  // The token only exists in the template's copy; substituting it here is what
  // puts the college's own name on the page it just created.
  return personalize(starter, collegeName);
}

/** Creates the default pages and a starter set of sections for a new site. */
async function provisionStarterSite(
  collegeId: string,
  collegeName: string,
  templateSections: TemplateSection[],
) {
  const existingPages = await prisma.page.count({ where: { collegeId } });

  if (existingPages === 0) {
    await prisma.page.createMany({
      data: DEFAULT_PAGES.map((page) => ({ collegeId, ...page })),
    });
  }

  const homePage = await prisma.page.findFirst({
    where: { collegeId },
    orderBy: { navOrder: "asc" },
  });
  if (!homePage) return;

  let displayOrder = 1;
  for (const section of templateSections) {
    const variantId = section.variants[0]?.id;
    if (!variantId) continue;
    if (!isSupportedSectionType(section.sectionType as never)) continue;

    await prisma.collegeSection.create({
      data: {
        collegeId,
        sectionId: section.id,
        variantId,
        pageId: homePage.id,
        displayOrder: displayOrder++,
        isVisible: true,
        content: starterContent(section, collegeName) as never,
      },
    });
  }
}

/**
 * "Start with this design": saves the chosen template and theme onto the
 * college, provisions starter sections if it has none, and reports where the
 * caller should land.
 *
 * Existing content is never touched — re-picking a theme only rewrites the
 * three foreign keys on `colleges`.
 */
export async function startWithDesign(
  collegeId: string,
  input: z.infer<typeof startWithDesignSchema>,
) {
  const { templateId, paletteId, fontId } = startWithDesignSchema.parse(input);

  const [college, template, palette, font] = await Promise.all([
    prisma.college.findUnique({ where: { id: collegeId } }),
    prisma.template.findUnique({
      where: { id: templateId },
      include: {
        sections: {
          orderBy: { defaultOrder: "asc" },
          include: { variants: { orderBy: VARIANT_ORDER } },
        },
      },
    }),
    prisma.themePalette.findUnique({ where: { id: paletteId } }),
    prisma.themeFont.findUnique({ where: { id: fontId } }),
  ]);

  if (!college) throw new NotFound("College not found");
  if (!template) throw new NotFound("Template not found");
  if (!palette) throw new NotFound("Theme palette not found");
  if (!font) throw new NotFound("Font pack not found");

  await prisma.college.update({
    where: { id: college.id },
    data: {
      templateId: template.id,
      themePaletteId: palette.id,
      themeFontId: font.id,
    },
  });

  const existingSections = await prisma.collegeSection.count({
    where: { collegeId: college.id },
  });

  if (existingSections === 0) {
    await provisionStarterSite(college.id, college.name, template.sections);
  }

  return { subdomain: college.subdomain, next: `/editor/${college.subdomain}` };
}

/**
 * Template-level refresh: the whole site's look, not one section's.
 *
 * The per-section ↻ swaps a variant within a section type. This swaps the
 * template underneath every section at once, which is only a data operation
 * because content lives in `college_sections.content` as JSONB keyed by section
 * type rather than by template — so re-pointing section_id/variant_id carries
 * the college's text across untouched.
 *
 * Three cases, and the awkward two are why this is not a one-line update:
 *  - the new template has the section type    -> re-point, keep content
 *  - it does not                              -> hide the row, never delete it,
 *    so the text is still there on the next refresh
 *  - it has a type the college never had      -> add it hidden, for them to
 *    fill in rather than publish empty
 *
 * Palette and font packs are deliberately untouched: this changes layout, not
 * the college's chosen colours.
 */
export async function cycleTemplate(collegeId: string) {
  const college = await prisma.college.findUnique({
    where: { id: collegeId },
    select: { id: true, name: true, subdomain: true, templateId: true },
  });
  if (!college) throw new NotFound("College not found");

  const templates = await prisma.template.findMany({
    orderBy: { name: "asc" },
    select: { id: true },
  });
  // Nothing to cycle to. Not an error — the button is disabled for this too.
  if (templates.length < 2) {
    return { subdomain: college.subdomain, changed: false as const };
  }

  // A college with no template yet lands on the first: findIndex gives -1, and
  // -1 + 1 is 0.
  const currentIndex = templates.findIndex((t) => t.id === college.templateId);
  const nextId = templates[(currentIndex + 1) % templates.length].id;

  const nextTemplate = await prisma.template.findUnique({
    where: { id: nextId },
    include: {
      sections: {
        orderBy: { defaultOrder: "asc" },
        include: { variants: { orderBy: VARIANT_ORDER } },
      },
    },
  });
  if (!nextTemplate) {
    return { subdomain: college.subdomain, changed: false as const };
  }

  // Section type -> where it lands in the new template. First variant by name,
  // the same default provisionStarterSite and addSection both pick.
  const target = new Map<
    string,
    { sectionId: string; variantId: string; defaultContent: unknown }
  >();
  for (const section of nextTemplate.sections) {
    const variant = section.variants[0];
    if (!variant) continue;
    if (!isSupportedSectionType(section.sectionType as never)) continue;
    if (target.has(section.sectionType)) continue;
    target.set(section.sectionType, {
      sectionId: section.id,
      variantId: variant.id,
      defaultContent: section.defaultContent,
    });
  }

  const rows = await prisma.collegeSection.findMany({
    where: { collegeId },
    include: { section: { select: { sectionType: true } } },
    orderBy: { displayOrder: "asc" },
  });

  const homePage = await prisma.page.findFirst({
    where: { collegeId },
    orderBy: { navOrder: "asc" },
  });

  await prisma.$transaction(async (tx) => {
    const covered = new Set<string>();

    for (const row of rows) {
      const match = target.get(row.section.sectionType);
      if (match) {
        covered.add(row.section.sectionType);
        await tx.collegeSection.update({
          where: { id: row.id },
          data: { sectionId: match.sectionId, variantId: match.variantId },
        });
      } else {
        await tx.collegeSection.update({
          where: { id: row.id },
          data: { isVisible: false },
        });
      }
    }

    if (homePage) {
      let displayOrder = Math.max(0, ...rows.map((r) => r.displayOrder)) + 1;
      for (const [sectionType, slot] of target) {
        if (covered.has(sectionType)) continue;
        await tx.collegeSection.create({
          data: {
            collegeId,
            pageId: homePage.id,
            sectionId: slot.sectionId,
            variantId: slot.variantId,
            displayOrder: displayOrder++,
            isVisible: false,
            // Valid starter copy rather than {}: the editor renders hidden rows
            // so they can be toggled on, and an empty object has no fields for
            // the component to draw.
            content: starterContent(
              { sectionType, defaultContent: slot.defaultContent },
              college.name,
            ) as never,
          },
        });
      }
    }

    await tx.college.update({
      where: { id: college.id },
      data: { templateId: nextTemplate.id },
    });
  });

  return { subdomain: college.subdomain, changed: true as const };
}

/**
 * The page a template *would* produce, without writing anything.
 *
 * Screen 2 asks a college with no site yet to judge a design, which it cannot
 * do from an empty frame: the site read correctly answers "nothing here" for a
 * college with no pages, and the preview iframe went blank at exactly the
 * moment the template most needed showing. This renders what "Start with this
 * design" is about to create — same starter pages, same first variant per
 * section, same default copy — so the preview is a promise the action keeps.
 */
export async function getTemplatePreview(
  subdomain: string,
  templateId: string,
) {
  const [college, template] = await Promise.all([
    prisma.college.findUnique({
      where: { subdomain },
      include: { themePalette: true, themeFont: true },
    }),
    prisma.template.findUnique({
      where: { id: templateId },
      include: {
        sections: {
          orderBy: { defaultOrder: "asc" },
          include: { variants: { orderBy: VARIANT_ORDER } },
        },
      },
    }),
  ]);

  if (!college || !template) return null;

  // Ids that cannot collide with a real row: these sections are never saved,
  // and treating one as a database id would silently edit the wrong thing.
  const pages = DEFAULT_PAGES.map((page) => ({
    id: `preview:${page.slug}`,
    slug: page.slug,
    title: page.title,
  }));

  const sections = [];
  let displayOrder = 1;

  for (const section of template.sections) {
    // Lead variant: sortOrder decides, which is what makes each template open
    // with its own look.
    const variant = section.variants[0];
    if (!variant) continue;
    if (!isSupportedSectionType(section.sectionType as never)) continue;

    sections.push({
      id: `preview:${section.id}`,
      sectionType: section.sectionType,
      componentKey: variant.componentKey,
      variantId: variant.id,
      variantName: variant.variantName,
      displayOrder: displayOrder++,
      isVisible: true,
      content: defaultContentFor(section.sectionType as never, college.name),
    });
  }

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
    pages,
    currentPage: pages[0],
    seo: {
      metaTitle: null,
      metaDescription: null,
      ogImage: null,
      canonicalSlug: null,
    },
    sections,
    isOwnerPreview: true,
  };
}

export { BadRequest };
