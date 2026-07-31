import { z } from "zod";

import { prisma } from "@/db";
import { startWithDesign } from "@/design-service";
import {
  collegeTypeSchema,
  subdomainFromName,
  templateNameFor,
} from "@/lib/college-types";
import { isUntouched, personalize } from "@/lib/sections/personalize";
import { OFFERABLE } from "@/library-service";
import { BadRequest, NotFound } from "@/sections-service";

/**
 * The two questions onboarding asks, and what "Build Site" does with them.
 *
 * These were Server Actions writing to Postgres from the frontend. That is the
 * path that showed people "The service is temporarily unavailable" and refused
 * to advance — the API was healthy the whole time and held the same data; the
 * other service simply had the wrong credentials for it.
 */

export const onboardingSchema = z.object({
  collegeName: z.string().trim().min(2, "Enter your college name").max(120),
  collegeType: collegeTypeSchema,
});

/** Subdomains the platform needs for itself. */
const RESERVED = new Set([
  "www",
  "api",
  "admin",
  "app",
  "editor",
  "site",
  "preview",
  "templates",
  "login",
  "signup",
  "start",
  "onboarding",
  "uploads",
]);

/**
 * A free subdomain derived from the college's name.
 *
 * Onboarding asks for two things and a URL has to come from somewhere.
 * Uniqueness is settled here rather than in the slug helper, because only a
 * query knows what is already taken.
 */
async function availableSubdomain(name: string): Promise<string> {
  const base = subdomainFromName(name);

  for (let suffix = 0; suffix < 50; suffix++) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    if (RESERVED.has(candidate)) continue;
    const taken = await prisma.college.findUnique({
      where: { subdomain: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }

  // Fifty collisions on one name is not a real college naming its site; it is
  // something looping. A timestamped slug ends it rather than spinning.
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Carries a new college name into the sections still showing starter copy.
 *
 * Answering "what is your college called" and then finding the old name across
 * the site makes the answer look ignored. Provisioning substitutes the name
 * once, at creation — so without this, changing it later fixes the heading in
 * the dashboard and nothing on the page.
 *
 * Only sections byte-identical to their template's starter copy are touched. A
 * section somebody has edited keeps every word of it, even the name: they may
 * have written it deliberately, and no automatic tidy-up is worth overwriting a
 * sentence a person typed.
 */
async function renameThroughStarterCopy(
  collegeId: string,
  previousName: string,
  nextName: string,
) {
  const rows = await prisma.collegeSection.findMany({
    where: { collegeId },
    include: { section: { select: { defaultContent: true } } },
  });

  for (const row of rows) {
    const starter = row.section.defaultContent;
    if (!starter) continue;
    if (!isUntouched(row.content, starter, previousName)) continue;

    await prisma.collegeSection.update({
      where: { id: row.id },
      data: { content: personalize(starter, nextName) as never },
    });
  }
}

/**
 * Records what onboarding asked for.
 *
 * In open-access mode a college already exists — the session resolves one on
 * first touch — so this updates that row rather than creating a second. A user
 * who has just told us their college's name should not end up with two.
 */
export async function completeOnboarding(
  collegeId: string,
  input: z.infer<typeof onboardingSchema>,
) {
  const parsed = onboardingSchema.parse(input);

  const college = await prisma.college.findUnique({
    where: { id: collegeId },
    select: {
      id: true,
      name: true,
      subdomain: true,
      _count: { select: { sections: true } },
    },
  });
  if (!college) throw new NotFound("College not found");

  // The URL is only rewritten while nothing is built on it. Once a site has
  // sections, its address is in the editor URL, the public URL and possibly
  // somebody's bookmarks — renaming it then breaks all three to gain nothing.
  const subdomain =
    college._count.sections === 0
      ? await availableSubdomain(parsed.collegeName)
      : college.subdomain;

  const previousName = college.name;

  await prisma.college.update({
    where: { id: college.id },
    data: {
      name: parsed.collegeName,
      collegeType: parsed.collegeType,
      subdomain,
    },
  });

  if (previousName !== parsed.collegeName) {
    await renameThroughStarterCopy(college.id, previousName, parsed.collegeName);
  }

  return { subdomain, next: "/start" };
}

/**
 * "Build Site": picks the template for this college's type and opens the editor
 * on it.
 *
 * Deliberately not random. The type was asked for precisely so this choice can
 * be made without asking again, and a college that answers "Medical" twice
 * should not get two different sites.
 *
 * The theme comes from that template's demo college, so the site opens looking
 * like the demo the gallery advertises rather than defaulting to whatever
 * palette happens to sort first.
 */
export async function buildSiteForType(collegeId: string) {
  const college = await prisma.college.findUnique({
    where: { id: collegeId },
    select: { id: true, collegeType: true },
  });
  if (!college) throw new NotFound("College not found");
  if (!college.collegeType) {
    throw new BadRequest("This college has not been asked its type yet");
  }

  const templateName = templateNameFor(college.collegeType);

  let template = await prisma.template.findFirst({
    where: { name: templateName, ...OFFERABLE },
    select: { id: true },
  });

  if (!template) {
    template = await prisma.template.findFirst({
      where: OFFERABLE,
      select: { id: true },
    });
  }

  if (!template) {
    throw new BadRequest(
      "No active templates available in the system. An admin must publish a template in the Admin Panel.",
    );
  }

  const demo = await prisma.college.findFirst({
    where: { isDemo: true, templateId: template.id },
    select: { themePaletteId: true, themeFontId: true },
  });

  const [palette, font] = await Promise.all([
    demo?.themePaletteId
      ? Promise.resolve({ id: demo.themePaletteId })
      : prisma.themePalette.findFirst({
          orderBy: { name: "asc" },
          select: { id: true },
        }),
    demo?.themeFontId
      ? Promise.resolve({ id: demo.themeFontId })
      : prisma.themeFont.findFirst({
          orderBy: { name: "asc" },
          select: { id: true },
        }),
  ]);

  if (!palette || !font) {
    throw new Error("No theme palettes or font packs configured");
  }

  // Reuses the existing path rather than a second copy of it: same template
  // assignment, same starter provisioning, same landing place. Both entry
  // points hand off to the identical code.
  return startWithDesign(collegeId, {
    templateId: template.id,
    paletteId: palette.id,
    fontId: font.id,
  });
}
