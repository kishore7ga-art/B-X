import "dotenv/config";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import { createPool } from "../src/lib/db-pool";
import { SectionType } from "../src/generated/prisma/enums";

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
 */
const VARIANT_LIBRARY = [
  {
    sectionType: SectionType.HERO,
    defaultOrder: 1,
    isRequired: true,
    variants: [
      { variantName: "Centered", componentKey: "hero_centered" },
      { variantName: "Image Split", componentKey: "hero_split_image" },
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

async function seedReferenceData() {
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

  for (const librarySpec of VARIANT_LIBRARY) {
    const sectionType = librarySpec.sectionType as SectionType;
    for (const [index, variant] of librarySpec.variants.entries()) {
      await prisma.sectionVariant.upsert({
        where: { componentKey: variant.componentKey },
        update: {
          variantName: variant.variantName,
          sectionType,
          sortOrder: index,
        },
        create: { ...variant, sectionType, sortOrder: index },
      });
    }
  }

  return { palettes, fonts };
}

async function main() {
  await seedReferenceData();

  const counts = {
    templates: await prisma.template.count(),
    sections: await prisma.section.count(),
    sectionVariants: await prisma.sectionVariant.count(),
    themePalettes: await prisma.themePalette.count(),
    themeFonts: await prisma.themeFont.count(),
    colleges: await prisma.college.count(),
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
