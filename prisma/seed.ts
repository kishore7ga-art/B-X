import "dotenv/config";

import bcrypt from "bcryptjs";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { createPool } from "../src/lib/db-pool";
import { COLLEGE_TYPES } from "../src/lib/college-types";
import { COLLEGE_NAME_TOKEN } from "../src/lib/sections/personalize";
import { stableStringify } from "../src/lib/json-stable";
import { defaultContentFor } from "../src/lib/sections/defaults";
import { DEMO_LOGIN } from "../src/lib/auth/demo";
import { CollegeStatus, SectionType } from "../src/generated/prisma/enums";
import {
  parseSectionContent,
  type SupportedSectionType,
} from "../src/lib/sections/schemas";

// Same cloud-tuned pool the app uses, so seeding works against a managed
// database (TLS) as well as local Postgres.
const pool = createPool();
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const PALETTES = [
  {
    name: "Academic Blue",
    colors: {
      primary: "#1E3A8A",
      secondary: "#3B82F6",
      accent: "#F59E0B",
      dark: "#0F172A",
      light: "#F8FAFC",
    },
  },
  {
    name: "Heritage Maroon",
    colors: {
      primary: "#7F1D1D",
      secondary: "#B91C1C",
      accent: "#D4A017",
      dark: "#1C1917",
      light: "#FEF7ED",
    },
  },
  {
    name: "Campus Green",
    colors: {
      primary: "#14532D",
      secondary: "#16A34A",
      accent: "#FACC15",
      dark: "#0B1F16",
      light: "#F0FDF4",
    },
  },
  {
    name: "Midnight Indigo",
    colors: {
      primary: "#312E81",
      secondary: "#6366F1",
      accent: "#10B981",
      dark: "#09090B",
      light: "#EEF2FF",
    },
  },
  {
    name: "Sunset Sapphire",
    colors: {
      primary: "#0369A1",
      secondary: "#0284C7",
      accent: "#F97316",
      dark: "#0F172A",
      light: "#F0F9FF",
    },
  },
  {
    name: "Editorial Plum",
    colors: {
      primary: "#581C87",
      secondary: "#9333EA",
      accent: "#EAB308",
      dark: "#18181B",
      light: "#FAF5FF",
    },
  },
];

/** Demo login for the sample college. Shared with the sign-in page's autofill. */
const SEED_LOGIN = DEMO_LOGIN;

const FONT_PACKS = [
  {
    name: "Classic Serif",
    headingFont: "Playfair Display",
    bodyFont: "Source Sans 3",
  },
  { name: "Modern Sans", headingFont: "Poppins", bodyFont: "Inter" },
  {
    name: "Editorial Elegance",
    headingFont: "Cormorant Garamond",
    bodyFont: "Plus Jakarta Sans",
  },
  {
    name: "Tech Precision",
    headingFont: "Outfit",
    bodyFont: "Roboto",
  },
  {
    name: "Academic Prestige",
    headingFont: "Merriweather",
    bodyFont: "Open Sans",
  },
];

/**
 * Every design variant that exists, by section type.
 *
 * All templates carry the whole library so the per-section ↻ has somewhere to
 * go inside any of them. What separates one template from the next is which
 * variant leads — see TEMPLATES below.
 */
const VARIANT_LIBRARY = [
  {
    sectionType: SectionType.HERO,
    defaultOrder: 1,
    isRequired: true,
    variants: [
      { variantName: "Centered", componentKey: "hero_centered" },
      { variantName: "Image Split", componentKey: "hero_split_image" },
      // Adapted from the AR academic template (CC BY 4.0). See
      // prisma/variants/001_hero_academic_masthead.sql
      { variantName: "Academic Masthead", componentKey: "hero_academic_masthead" },
      { variantName: "Minimal Text", componentKey: "hero_minimal_text" },
      { variantName: "Side Panel", componentKey: "hero_side_panel" },
      { variantName: "Stacked Banner", componentKey: "hero_stacked_banner" },
    ],
  },
  {
    sectionType: SectionType.ABOUT,
    defaultOrder: 2,
    isRequired: false,
    variants: [
      { variantName: "Two Column", componentKey: "about_two_column" },
      { variantName: "Stacked Cards", componentKey: "about_stacked_cards" },
      { variantName: "Timeline", componentKey: "about_timeline" },
      { variantName: "Quote Lead", componentKey: "about_quote_lead" },
      { variantName: "Image Beside", componentKey: "about_image_beside" },
      { variantName: "Split Panel", componentKey: "about_split_panel" },
    ],
  },
  {
    sectionType: SectionType.COURSES,
    defaultOrder: 3,
    isRequired: false,
    variants: [
      { variantName: "Card Grid", componentKey: "courses_card_grid" },
      { variantName: "Comparison Table", componentKey: "courses_table" },
      { variantName: "Accordion", componentKey: "courses_accordion" },
      { variantName: "Numbered List", componentKey: "courses_numbered_list" },
      { variantName: "Split Rows", componentKey: "courses_split_rows" },
      { variantName: "Compact Tiles", componentKey: "courses_compact_tiles" },
    ],
  },
  {
    sectionType: SectionType.FACULTY,
    defaultOrder: 4,
    isRequired: false,
    variants: [
      { variantName: "Photo Cards", componentKey: "faculty_photo_cards" },
      { variantName: "Roster List", componentKey: "faculty_roster_list" },
      { variantName: "Circle Grid", componentKey: "faculty_circle_grid" },
      { variantName: "Department Groups", componentKey: "faculty_department_groups" },
      { variantName: "Overlay Tiles", componentKey: "faculty_overlay_tiles" },
      { variantName: "Minimal Table", componentKey: "faculty_minimal_table" },
    ],
  },
  {
    sectionType: SectionType.CONTACT,
    defaultOrder: 5,
    isRequired: true,
    variants: [
      { variantName: "Split Map", componentKey: "contact_map_split" },
      { variantName: "Centered", componentKey: "contact_centered" },
      { variantName: "Form Only", componentKey: "contact_form_only" },
      { variantName: "Full Width Map", componentKey: "contact_full_width_map" },
      { variantName: "Cards Row", componentKey: "contact_cards_row" },
      { variantName: "Dark Panel", componentKey: "contact_dark_panel" },
    ],
  },
];

/**
 * The gallery.
 *
 * Each template leads with a different variant of every section, which is what
 * makes five entries built from one component library look like five designs
 * rather than one design five times. `lead` sets sortOrder 0; the rest of the
 * library follows in its declared order, so ↻ still reaches everything.
 *
 * Each also names a demo college — a published showcase seeded alongside it, so
 * "View demo site" leads somewhere real instead of at the visitor's own empty
 * site.
 */
type TemplateSpec = {
  name: string;
  description: string;
  thumbnailUrl: string;
  demo: {
    subdomain: string;
    collegeName: string;
    tagline: string;
    city: string;
    domain: string;
    paletteName: string;
    fontName: string;
  };
  lead: Record<SupportedSectionType, string>;
};

const TEMPLATES: TemplateSpec[] = [
  {
    name: "Radian",
    description:
      "A clean, content-first template for technical colleges and institutes.",
    thumbnailUrl: "/seed/template-radian.svg",
    demo: {
      subdomain: "demo-radian",
      collegeName: "Greenfield Institute of Technology",
      tagline: "Engineering tomorrow, today",
      city: "Greenfield, Karnataka 562109",
      domain: "greenfield.edu.in",
      paletteName: "Academic Blue",
      fontName: "Classic Serif",
    },
    lead: {
      [SectionType.HERO]: "hero_academic_masthead",
      [SectionType.ABOUT]: "about_image_beside",
      [SectionType.COURSES]: "courses_accordion",
      [SectionType.FACULTY]: "faculty_circle_grid",
      [SectionType.CONTACT]: "contact_cards_row",
    },
  },
  {
    name: "Meridian",
    description:
      "Spare and typographic. Wide margins, restrained colour, everything earning its place — for institutions that would rather read serious than loud.",
    thumbnailUrl: "/seed/template-meridian.svg",
    demo: {
      subdomain: "demo-meridian",
      collegeName: "Meridian School of Design",
      tagline: "Make things that matter",
      city: "Panaji, Goa 403001",
      domain: "meridian.edu.in",
      paletteName: "Academic Blue",
      fontName: "Modern Sans",
    },
    lead: {
      [SectionType.HERO]: "hero_minimal_text",
      [SectionType.ABOUT]: "about_two_column",
      [SectionType.COURSES]: "courses_compact_tiles",
      [SectionType.FACULTY]: "faculty_minimal_table",
      [SectionType.CONTACT]: "contact_centered",
    },
  },
  {
    name: "Beacon",
    description:
      "Full-bleed banners, big type and a dark closing panel. Built to be seen first and read second — suits admissions-led campaigns.",
    thumbnailUrl: "/seed/template-beacon.svg",
    demo: {
      subdomain: "demo-beacon",
      collegeName: "Beacon College of Management",
      tagline: "Where ambition finds its footing",
      city: "Pune, Maharashtra 411045",
      domain: "beacon.edu.in",
      paletteName: "Heritage Maroon",
      fontName: "Modern Sans",
    },
    lead: {
      [SectionType.HERO]: "hero_stacked_banner",
      [SectionType.ABOUT]: "about_quote_lead",
      [SectionType.COURSES]: "courses_card_grid",
      [SectionType.FACULTY]: "faculty_overlay_tiles",
      [SectionType.CONTACT]: "contact_dark_panel",
    },
  },
  {
    name: "Almanac",
    description:
      "Traditional and record-like: a dated timeline, a comparison table of programmes, faculty grouped by department. For institutions whose age is the point.",
    thumbnailUrl: "/seed/template-almanac.svg",
    demo: {
      subdomain: "demo-almanac",
      collegeName: "St. Alban's College",
      tagline: "Learning, unbroken since 1892",
      city: "Kochi, Kerala 682011",
      domain: "stalbans.edu.in",
      paletteName: "Heritage Maroon",
      fontName: "Classic Serif",
    },
    lead: {
      [SectionType.HERO]: "hero_side_panel",
      [SectionType.ABOUT]: "about_timeline",
      [SectionType.COURSES]: "courses_table",
      [SectionType.FACULTY]: "faculty_department_groups",
      [SectionType.CONTACT]: "contact_map_split",
    },
  },
  {
    name: "Harbour",
    description:
      "Warm and photographic — a split hero, stacked story cards, faces before titles. Reads like a place rather than a prospectus.",
    thumbnailUrl: "/seed/template-harbour.svg",
    demo: {
      subdomain: "demo-harbour",
      collegeName: "Harbour Community College",
      tagline: "Start where you are",
      city: "Visakhapatnam, Andhra Pradesh 530003",
      domain: "harbour.edu.in",
      paletteName: "Campus Green",
      fontName: "Modern Sans",
    },
    lead: {
      [SectionType.HERO]: "hero_split_image",
      [SectionType.ABOUT]: "about_stacked_cards",
      [SectionType.COURSES]: "courses_numbered_list",
      [SectionType.FACULTY]: "faculty_photo_cards",
      [SectionType.CONTACT]: "contact_full_width_map",
    },
  },
];

/**
 * Section copy for a demo site. Parameterised rather than fixed: five
 * showcases that all call themselves Greenfield would read as one site
 * restyled, which is the opposite of what a gallery is for.
 */
const contentFor = (
  d: TemplateSpec["demo"],
): Record<SupportedSectionType, unknown> => ({
  [SectionType.HERO]: {
    collegeName: d.collegeName,
    tagline: d.tagline,
    intro:
      "A NAAC A+ accredited institute offering undergraduate and postgraduate programmes in engineering, management and applied sciences since 1998.",
    bannerImageUrl: "/template-brightwood.jpg",
    ctaLabel: "Apply for admission",
    ctaHref: "/admissions",
  },
  [SectionType.ABOUT]: {
    title: `About ${d.collegeName}`,
    history:
      `Founded in 1998, ${d.collegeName} began with three departments and 120 students. It now serves over 4,000 students across 14 departments on a 42-acre campus.`,
    mission:
      "To deliver rigorous, industry-relevant technical education that is accessible to students from every background.",
    vision:
      "To be recognised among the leading centres of applied research and engineering education in the region by 2030.",
    principalName: "Dr. Anita Raghavan",
    principalDesignation: "Principal",
    // `/hero-madras-college.jpg` was seeded here and has never existed in
    // public/, so every seeded About section asked for a 404 and fell through to
    // SiteImage's campus photo — a building where a portrait belongs. The seed
    // placeholder is a portrait, and a college replaces it with its own.
    principalPhotoUrl: "/seed/principal.svg",
    principalMessage:
      `Our students leave ${d.collegeName} with more than a degree — they leave with the habit of solving real problems. That is the promise we renew with every incoming batch.`,
  },
  [SectionType.COURSES]: {
    title: "Courses & Departments",
    subtitle: "Fourteen AICTE-approved programmes across three faculties.",
    courses: [
      {
        name: "B.Tech — Computer Science & Engineering",
        duration: "4 years",
        eligibility: "10+2 with Physics, Chemistry, Mathematics (min. 60%)",
        description:
          "Core computing, data structures, AI/ML electives and a two-semester industry capstone.",
      },
      {
        name: "B.Tech — Mechanical Engineering",
        duration: "4 years",
        eligibility: "10+2 with Physics, Chemistry, Mathematics (min. 55%)",
        description:
          "Thermal sciences, design and manufacturing with a dedicated CNC and robotics lab.",
      },
      {
        name: "B.Tech — Electronics & Communication",
        duration: "4 years",
        eligibility: "10+2 with Physics, Chemistry, Mathematics (min. 55%)",
        description:
          "VLSI, embedded systems and communication networks with an in-house fabrication lab.",
      },
      {
        name: "M.Tech — Structural Engineering",
        duration: "2 years",
        eligibility: "B.E./B.Tech in Civil Engineering with a valid GATE score",
        description:
          "Advanced structural analysis, earthquake engineering and a research thesis.",
      },
      {
        name: "MBA — Business Administration",
        duration: "2 years",
        eligibility: "Bachelor's degree in any discipline (min. 50%)",
        description:
          "Specialisations in finance, marketing, operations and human resources.",
      },
    ],
  },
  [SectionType.FACULTY]: {
    title: "Our Faculty",
    subtitle: "218 full-time faculty members, 64 of them with doctorates.",
    members: [
      {
        name: "Dr. Anita Raghavan",
        designation: "Principal & Professor",
        department: "Computer Science & Engineering",
        photoUrl: "/template-evergreen.jpg",
      },
      {
        name: "Dr. Suresh Menon",
        designation: "Head of Department",
        department: "Mechanical Engineering",
        photoUrl: "/template-calistoga.jpg",
      },
      {
        name: "Prof. Kavitha Nair",
        designation: "Associate Professor",
        department: "Electronics & Communication",
        photoUrl: "/template-oakwood.jpg",
      },
      {
        name: "Dr. Imran Qureshi",
        designation: "Assistant Professor",
        department: "Civil Engineering",
        photoUrl: "/macbook-madras-college.png",
      },
    ],
  },
  [SectionType.CONTACT]: {
    title: "Contact Us",
    address: `${d.collegeName}, NH-48, Bypass Road, ${d.city}`,
    phone: "+91 80 2345 6789",
    email: `admissions@${d.domain}`,
    mapEmbedUrl: "",
    showContactForm: true,
  },
});

/** Sections placed on each page of the seeded college, in display order. */
const PAGE_LAYOUT: {
  slug: string;
  title: string;
  navOrder: number;
  sections: SupportedSectionType[];
}[] = [
  {
    slug: "home",
    title: "Home",
    navOrder: 0,
    sections: [
      SectionType.HERO,
      SectionType.ABOUT,
      SectionType.COURSES,
      SectionType.FACULTY,
      SectionType.CONTACT,
    ],
  },
  {
    slug: "about",
    title: "About Us",
    navOrder: 1,
    sections: [SectionType.ABOUT, SectionType.FACULTY],
  },
  {
    slug: "academics",
    title: "Academics",
    navOrder: 2,
    sections: [SectionType.COURSES],
  },
  {
    slug: "events",
    title: "Events & News",
    navOrder: 3,
    sections: [SectionType.ABOUT, SectionType.COURSES],
  },
  {
    slug: "faculty",
    title: "Faculty",
    navOrder: 4,
    sections: [SectionType.FACULTY],
  },
  {
    slug: "admissions",
    title: "Admissions",
    navOrder: 5,
    sections: [SectionType.COURSES, SectionType.CONTACT],
  },
  {
    slug: "contact",
    title: "Contact Us",
    navOrder: 6,
    sections: [SectionType.CONTACT],
  },
];

/**
 * The demo college ships a login whose password is published in the README, so
 * it must never be created on a deployed instance. `scripts/start.mjs` sets
 * SEED_DEMO_COLLEGE=false; `npm run db:seed` leaves it unset and gets the full
 * local fixture.
 */
const INCLUDE_DEMO_COLLEGE = process.env.SEED_DEMO_COLLEGE !== "false";

/**
 * Templates, theme options and the section-variant library. This is reference
 * data, not sample content: without it the template gallery is empty and a new
 * signup has nothing to build a site from, so it is seeded on every boot.
 * Every write is an upsert keyed on a natural key, so re-running is a no-op.
 */
async function seedReferenceData() {
  // --- Theme options -------------------------------------------------------
  const palettes = await Promise.all(
    PALETTES.map((p) =>
      prisma.themePalette.upsert({
        where: { name: p.name },
        update: { colors: p.colors },
        create: p,
      }),
    ),
  );

  const fonts = await Promise.all(
    FONT_PACKS.map((f) =>
      prisma.themeFont.upsert({
        where: { name: f.name },
        update: f,
        create: f,
      }),
    ),
  );

  // --- Templates, each carrying the whole variant library -------------------
  /**
   * The shared design library, seeded once for every template at once.
   *
   * Keyed on `componentKey`, which is globally unique now, so re-running this is
   * an update rather than a fourth copy. `sortOrder` is the library's own picker
   * order and no longer carries "which one does this template lead with" — that
   * moved to `sections.default_variant_id`, set per template below.
   */
  const libraryIds = new Map<string, string>();

  for (const librarySpec of VARIANT_LIBRARY) {
    const sectionType = librarySpec.sectionType as SupportedSectionType;
    for (const [index, variant] of librarySpec.variants.entries()) {
      const row = await prisma.sectionVariant.upsert({
        where: { componentKey: variant.componentKey },
        update: {
          variantName: variant.variantName,
          sectionType,
          sortOrder: index,
        },
        create: { ...variant, sectionType, sortOrder: index },
      });
      libraryIds.set(variant.componentKey, row.id);
    }
  }

  const templates = [];

  for (const spec of TEMPLATES) {
    // The demo site keeps its own identity; the starter copy every college
    // receives carries a token where the name goes, plus neutral contact
    // details, so a new site opens as itself rather than as Greenfield.
    const templateContent = contentFor({
      ...spec.demo,
      collegeName: COLLEGE_NAME_TOKEN,
      city: "Your city, State 000000",
      domain: "yourcollege.edu",
    });

    const template = await prisma.template.upsert({
      where: { name: spec.name },
      // Updated, not left alone: descriptions and thumbnails get revised, and a
      // seed that only writes on first run leaves every existing database
      // showing the old copy forever.
      update: {
        description: spec.description,
        thumbnailUrl: spec.thumbnailUrl,
        demoUrl: `/site/${spec.demo.subdomain}`,
      },
      create: {
        name: spec.name,
        description: spec.description,
        thumbnailUrl: spec.thumbnailUrl,
        demoUrl: `/site/${spec.demo.subdomain}`,
      },
    });

    const sectionsByType = new Map<
      SupportedSectionType,
      { id: string; leadVariantId: string }
    >();

    for (const librarySpec of VARIANT_LIBRARY) {
      const sectionType = librarySpec.sectionType as SupportedSectionType;

      const section = await prisma.section.upsert({
        where: {
          templateId_sectionType: { templateId: template.id, sectionType },
        },
        update: {
          defaultOrder: librarySpec.defaultOrder,
          isRequired: librarySpec.isRequired,
          defaultContent: templateContent[sectionType] as never,
        },
        create: {
          templateId: template.id,
          sectionType,
          defaultOrder: librarySpec.defaultOrder,
          isRequired: librarySpec.isRequired,
          defaultContent: templateContent[sectionType] as never,
        },
      });

      /**
       * The lead is recorded on the slot; the designs themselves are seeded once,
       * above, for every template at the same time.
       *
       * This loop used to insert the whole library per template — the same design
       * five times over, ordered so that each template's lead came out first. That
       * is what made 30 designs into 150 rows. The library is shared now, so the
       * only per-template fact left is which of them this template opens with, and
       * that is a column on the slot.
       */
      const leadKey = spec.lead[sectionType];
      const lead = libraryIds.get(leadKey);
      if (!lead) {
        throw new Error(
          `${spec.name}: lead variant "${leadKey}" is not in the ${sectionType} library`,
        );
      }

      await prisma.section.update({
        where: { id: section.id },
        data: { defaultVariantId: lead },
      });

      sectionsByType.set(sectionType, { id: section.id, leadVariantId: lead });
    }

    templates.push({ spec, template, sectionsByType });
  }

  return { palettes, fonts, templates };
}

/**
 * A published showcase site per template.
 *
 * Seeded in production too, unlike the demo *login* below: these carry no
 * credentials, only content, so there is nothing to get in with. Without them
 * the gallery's "View demo site" has nowhere to point, and a visitor deciding
 * between five templates is choosing from thumbnails alone.
 *
 * Marked isDemo so open-access mode never hands one to a visitor as their own.
 */
async function seedDemoSites({
  palettes,
  fonts,
  templates,
}: Awaited<ReturnType<typeof seedReferenceData>>) {
  for (const { spec, template, sectionsByType } of templates) {
    const palette =
      palettes.find((p) => p.name === spec.demo.paletteName) ?? palettes[0];
    const font = fonts.find((f) => f.name === spec.demo.fontName) ?? fonts[0];

    // The type this template serves, so a demo is a worked example of the
    // onboarding mapping rather than an untyped row.
    const servedType = COLLEGE_TYPES.find(
      (type) => type.templateName === spec.name,
    );

    const shared = {
      name: spec.demo.collegeName,
      collegeType: servedType?.value ?? null,
      templateId: template.id,
      themePaletteId: palette.id,
      themeFontId: font.id,
      // Published, or resolveSiteAccess hides it from everyone but its owner —
      // and a demo has no owner to sign in as.
      status: CollegeStatus.PUBLISHED,
      isDemo: true,
    };

    const college = await prisma.college.upsert({
      where: { subdomain: spec.demo.subdomain },
      update: shared,
      create: { subdomain: spec.demo.subdomain, ...shared },
    });

    // Rebuilt every run so a demo always shows the template's current lead
    // variants rather than whatever it was first seeded with.
    await prisma.collegeSection.deleteMany({ where: { collegeId: college.id } });
    await prisma.page.deleteMany({ where: { collegeId: college.id } });

    const content = contentFor(spec.demo);

    for (const pageSpec of PAGE_LAYOUT) {
      const page = await prisma.page.create({
        data: {
          collegeId: college.id,
          slug: pageSpec.slug,
          title: pageSpec.title,
          navOrder: pageSpec.navOrder,
        },
      });

      for (const [index, sectionType] of pageSpec.sections.entries()) {
        const section = sectionsByType.get(sectionType);
        if (!section) throw new Error(`Unseeded section type: ${sectionType}`);

        await prisma.collegeSection.create({
          data: {
            collegeId: college.id,
            sectionId: section.id,
            // Index 0 is the lead variant — the template's signature look.
            variantId: section.leadVariantId,
            pageId: page.id,
            displayOrder: index + 1,
            isVisible: true,
            content: parseSectionContent(sectionType, content[sectionType]),
          },
        });
      }
    }
  }
}

/** Local-development fixture: one published-ready college with real content. */
async function seedDemoCollege({
  palettes,
  fonts,
  templates,
}: Awaited<ReturnType<typeof seedReferenceData>>) {
  // The first template in the gallery; this fixture only needs a valid one.
  const { template, sectionsByType } = templates[0];

  // --- Sample college ------------------------------------------------------
  const college = await prisma.college.upsert({
    where: { subdomain: "greenfield" },
    update: {
      templateId: template.id,
      themePaletteId: palettes[0].id,
      themeFontId: fonts[0].id,
    },
    create: {
      name: "Greenfield Institute of Technology",
      subdomain: "greenfield",
      templateId: template.id,
      themePaletteId: palettes[0].id,
      themeFontId: fonts[0].id,
      status: CollegeStatus.DRAFT,
    },
  });

  // Login account for the sample college.
  await prisma.user.upsert({
    where: { email: SEED_LOGIN.email },
    update: { collegeId: college.id },
    create: {
      email: SEED_LOGIN.email,
      passwordHash: await bcrypt.hash(SEED_LOGIN.password, 12),
      collegeId: college.id,
    },
  });

  // Rebuild this college's pages and sections so the seed is re-runnable.
  await prisma.collegeSection.deleteMany({ where: { collegeId: college.id } });
  await prisma.page.deleteMany({ where: { collegeId: college.id } });

  for (const pageSpec of PAGE_LAYOUT) {
    const page = await prisma.page.create({
      data: {
        collegeId: college.id,
        slug: pageSpec.slug,
        title: pageSpec.title,
        navOrder: pageSpec.navOrder,
      },
    });

    for (const [index, sectionType] of pageSpec.sections.entries()) {
      const section = sectionsByType.get(sectionType);
      if (!section) throw new Error(`Unseeded section type: ${sectionType}`);

      await prisma.collegeSection.create({
        data: {
          collegeId: college.id,
          sectionId: section.id,
          variantId: section.leadVariantId,
          pageId: page.id,
          displayOrder: index + 1,
          isVisible: true,
          // Validated against the section's Zod schema before it is stored.
          content: parseSectionContent(
            sectionType,
            contentFor(templates[0].spec.demo)[sectionType],
          ),
        },
      });
    }
  }

  console.log(
    `Login: ${SEED_LOGIN.email} / ${SEED_LOGIN.password}  ->  /editor/greenfield`,
  );
}

/**
 * Upgrades sections still holding the generic stub to their template's own
 * starter copy.
 *
 * Sites provisioned before templates carried default_content opened on "About
 * Us" over empty space while the gallery demo beside them looked finished.
 *
 * Only rewrites content byte-identical to the stub this code would generate —
 * i.e. a section nobody has touched. Anything edited, even one word, is left
 * exactly as the college left it. Nothing here is worth overwriting a real
 * sentence for.
 */
async function backfillStarterContent() {
  const rows = await prisma.collegeSection.findMany({
    where: { college: { isDemo: false } },
    include: {
      section: { select: { sectionType: true, defaultContent: true } },
      college: { select: { name: true } },
    },
  });

  let upgraded = 0;

  for (const row of rows) {
    if (!row.section.defaultContent) continue;

    const stub = parseSectionContent(
      row.section.sectionType as SupportedSectionType,
      defaultContentFor(row.section.sectionType as never, row.college.name),
    );

    if (stableStringify(row.content) !== stableStringify(stub)) continue;

    await prisma.collegeSection.update({
      where: { id: row.id },
      data: { content: row.section.defaultContent as never },
    });
    upgraded += 1;
  }

  if (upgraded) {
    console.log(`[seed] filled ${upgraded} untouched section(s) with template copy`);
  }
}

async function main() {
  const reference = await seedReferenceData();

  // Always, including production: these are the gallery's showcases and they
  // carry no credentials, so there is nothing to sign in to.
  await seedDemoSites(reference);

  await backfillStarterContent();

  if (INCLUDE_DEMO_COLLEGE) {
    await seedDemoCollege(reference);
  } else {
    console.log(
      "[seed] SEED_DEMO_COLLEGE=false — reference data only, no demo college.",
    );
  }

  const counts = {
    templates: await prisma.template.count(),
    sections: await prisma.section.count(),
    sectionVariants: await prisma.sectionVariant.count(),
    themePalettes: await prisma.themePalette.count(),
    themeFonts: await prisma.themeFont.count(),
    colleges: await prisma.college.count(),
    demoSites: await prisma.college.count({ where: { isDemo: true } }),
    users: await prisma.user.count(),
    pages: await prisma.page.count(),
    collegeSections: await prisma.collegeSection.count(),
  };

  console.log("Seed complete:", counts);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
