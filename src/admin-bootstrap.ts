import bcrypt from "bcryptjs";

import { prisma } from "@/db";

/**
 * What the last boot did, for `/api/v1/admin/status` to report.
 *
 * Everything below writes its decision to a log, and a log is behind a
 * dashboard, an ssh key or a support request. When a sign-in fails there are
 * three possible causes — the variables never reached this service, they reached
 * it and were refused, or they were applied and the password being typed is
 * simply wrong — and telling them apart from a browser was impossible. This is
 * the outcome only: no email, no password, no lengths.
 */
export type BootstrapOutcome =
  | "idle"
  | "created"
  | "reset"
  | "matched"
  | "refused"
  | "failed";

let lastOutcome: BootstrapOutcome = "idle";

export function bootstrapState() {
  return {
    /** Whether both variables are present on *this* service. */
    varsSet: Boolean(
      process.env.ADMIN_BOOTSTRAP_EMAIL?.trim() &&
        process.env.ADMIN_BOOTSTRAP_PASSWORD,
    ),
    lastRun: lastOutcome,
  };
}

/**
 * The account this repository ships with, for a deployment that has set nothing.
 *
 * A committed credential, which is normally the wrong answer and is the right
 * one here for two reasons. This repository is private, so it is readable by
 * exactly the people who can already read DATABASE_URL and write the row
 * themselves. And the alternative on offer was removing the login page — an
 * unauthenticated admin API on a public domain, which is not a trade worth
 * making to save one environment variable.
 *
 * `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` still take precedence, and
 * this is applied *once* — see `DEFAULT_APPLIED_MARKER`. It is a way in, not a
 * password the deployment is stuck with.
 */
const DEFAULT_ADMIN = {
  email: "admin@xite.co.in",
  password: "2008",
};

/**
 * Records that the committed default has had its turn.
 *
 * Without it, every deploy would reset the password back — so changing it would
 * last exactly until the next push, and the first thing anybody is told to do
 * with a default credential is change it. The marker means the default opens the
 * door once and never touches the account again.
 *
 * The environment variables are deliberately not subject to this: setting them is
 * a live instruction, and a deployment that wants a password re-applied on every
 * boot can have one.
 */
const DEFAULT_APPLIED_MARKER = "admin_default_applied";

/**
 * Makes the configured Super Admin true at boot: creates it, or sets its
 * password to the one given.
 *
 * The CLI is the right way to manage an admin account, and it stays the right
 * way — but it needs a shell on the box, and a Dokploy deployment is a
 * dashboard with environment variables long before it is a terminal somebody
 * is comfortable in. Without this the panel ships complete and unreachable,
 * which is how it went out.
 *
 * It used to refuse the moment any admin existed, which read as safe and left
 * one hole it could not climb out of: a deployment with an account whose
 * password nobody knows. That is not a hypothetical — a bootstrapped account and
 * a password set later on a different database is exactly it, and the login says
 * "Incorrect password or code" with no way in from the dashboard. So it now
 * resets rather than skips.
 *
 * That is not a new privilege. Anybody who can set these variables can already
 * set ADMIN_SESSION_SECRET and sign their own session, or read DATABASE_URL and
 * write the row directly. What keeps it honest:
 *
 * It is idempotent and quiet when nothing needs doing — a password that already
 * matches is left alone rather than rehashed on every restart.
 *
 * It says what it did, loudly, including telling you to remove the variables.
 * Credentials sitting in a dashboard after they have been used are credentials
 * in a dashboard, and while they are set every deploy applies them again.
 */
export async function bootstrapAdmin() {
  const envEmail = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const envPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const fromEnv = Boolean(envEmail && envPassword);

  const email = fromEnv ? envEmail! : DEFAULT_ADMIN.email;
  const password = fromEnv ? envPassword! : DEFAULT_ADMIN.password;

  try {
    // The committed default gets one turn, ever. Anything the environment says
    // is a live instruction and is applied every boot.
    if (password.length < 1) {
      lastOutcome = "refused";
      console.error(
        "[admin] bootstrap refused — password is empty.",
      );
      return;
    }

    const existing = await prisma.adminUser.findUnique({ where: { email } });

    if (!existing) {
      await prisma.adminUser.create({
        data: { email, passwordHash: await bcrypt.hash(password, 12) },
      });
      lastOutcome = "created";
      console.log(`[admin] created Super Admin: ${email}`);
    } else if (await bcrypt.compare(password, existing.passwordHash)) {
      lastOutcome = "matched";
      console.log(`[admin] ${email} already has this password.`);
    } else {
      await prisma.adminUser.update({
        where: { id: existing.id },
        data: { passwordHash: await bcrypt.hash(password, 12) },
      });
      lastOutcome = "reset";
      console.log(
        `[admin] reset the password for ${email} from ` +
          `${fromEnv ? "the environment" : "the committed default"}.`,
      );
    }

    if (fromEnv) {
      console.log(
        "[admin] REMOVE ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD now — " +
          "they have done their job, and while they are set every deploy applies " +
          "them again.",
      );
      return;
    }

    // Burn the default's one turn, whether it created the account or reset it.
    // Written after the fact rather than before: a marker set ahead of a write
    // that then failed would lock the door it was meant to open.
    await prisma.serviceSecret
      .create({
        data: { name: DEFAULT_APPLIED_MARKER, value: new Date().toISOString() },
      })
      .catch(() => {
        // Another worker won the race and wrote it first. Same outcome.
      });

    console.warn(
      `[admin] This deployment is using the committed default password for ` +
        `${email}. It will not be applied again — change it now:\n` +
        "    node scripts/admin.mjs password <email> <new password>",
    );

    await bootstrapTemplates();
  } catch (error) {
    // Never fatal. A service that will not start because it could not create an
    // admin account is a service that has taken every college's site down over
    // a convenience.
    lastOutcome = "failed";
    console.error("[admin] bootstrap failed:", (error as Error).message);
  }
}

const TEMPLATES_INITIALIZED_MARKER = "templates_initial_seed_done";

export async function bootstrapTemplates() {
  try {
    const marker = await prisma.serviceSecret
      .findUnique({ where: { name: TEMPLATES_INITIALIZED_MARKER } })
      .catch(() => null);

    if (marker) return;

    const templateCount = await prisma.template.count();
    if (templateCount > 0) {
      await prisma.serviceSecret
        .create({
          data: { name: TEMPLATES_INITIALIZED_MARKER, value: new Date().toISOString() },
        })
        .catch(() => {});
      return;
    }

    console.log("[bootstrap] First-time setup: 0 templates found in database. Seeding initial reference templates...");

    const PALETTES = [
      { name: "Academic Blue", colors: { primary: "#1E3A8A", secondary: "#3B82F6", accent: "#F59E0B", dark: "#0F172A", light: "#F8FAFC" } },
      { name: "Heritage Maroon", colors: { primary: "#7F1D1D", secondary: "#B91C1C", accent: "#D4A017", dark: "#1C1917", light: "#FEF7ED" } },
      { name: "Campus Green", colors: { primary: "#14532D", secondary: "#16A34A", accent: "#FACC15", dark: "#0B1F16", light: "#F0FDF4" } },
      { name: "Midnight Indigo", colors: { primary: "#312E81", secondary: "#6366F1", accent: "#10B981", dark: "#09090B", light: "#EEF2FF" } },
      { name: "Sunset Sapphire", colors: { primary: "#0369A1", secondary: "#0284C7", accent: "#F97316", dark: "#0F172A", light: "#F0F9FF" } },
      { name: "Editorial Plum", colors: { primary: "#581C87", secondary: "#9333EA", accent: "#EAB308", dark: "#18181B", light: "#FAF5FF" } },
    ];

    const FONT_PACKS = [
      { name: "Classic Serif", headingFont: "Playfair Display", bodyFont: "Source Sans 3" },
      { name: "Modern Sans", headingFont: "Poppins", bodyFont: "Inter" },
      { name: "Editorial Elegance", headingFont: "Cormorant Garamond", bodyFont: "Plus Jakarta Sans" },
      { name: "Tech Precision", headingFont: "Outfit", bodyFont: "Roboto" },
      { name: "Academic Prestige", headingFont: "Merriweather", bodyFont: "Open Sans" },
    ];

    for (const p of PALETTES) {
      await prisma.themePalette.upsert({ where: { name: p.name }, update: { colors: p.colors }, create: p });
    }
    for (const f of FONT_PACKS) {
      await prisma.themeFont.upsert({ where: { name: f.name }, update: f, create: f });
    }

    const VARIANT_SPECS = [
      { sectionType: "HERO", sortOrder: 0, variantName: "Centered", componentKey: "hero_centered" },
      { sectionType: "HERO", sortOrder: 1, variantName: "Image Split", componentKey: "hero_split_image" },
      { sectionType: "HERO", sortOrder: 2, variantName: "Academic Masthead", componentKey: "hero_academic_masthead" },
      { sectionType: "HERO", sortOrder: 3, variantName: "Minimal Text", componentKey: "hero_minimal_text" },
      { sectionType: "HERO", sortOrder: 4, variantName: "Side Panel", componentKey: "hero_side_panel" },
      { sectionType: "HERO", sortOrder: 5, variantName: "Stacked Banner", componentKey: "hero_stacked_banner" },
      { sectionType: "ABOUT", sortOrder: 0, variantName: "Two Column", componentKey: "about_two_column" },
      { sectionType: "ABOUT", sortOrder: 1, variantName: "Stacked Cards", componentKey: "about_stacked_cards" },
      { sectionType: "ABOUT", sortOrder: 2, variantName: "Timeline", componentKey: "about_timeline" },
      { sectionType: "ABOUT", sortOrder: 3, variantName: "Quote Lead", componentKey: "about_quote_lead" },
      { sectionType: "ABOUT", sortOrder: 4, variantName: "Image Beside", componentKey: "about_image_beside" },
      { sectionType: "ABOUT", sortOrder: 5, variantName: "Split Panel", componentKey: "about_split_panel" },
      { sectionType: "COURSES", sortOrder: 0, variantName: "Card Grid", componentKey: "courses_card_grid" },
      { sectionType: "COURSES", sortOrder: 1, variantName: "Comparison Table", componentKey: "courses_table" },
      { sectionType: "COURSES", sortOrder: 2, variantName: "Accordion", componentKey: "courses_accordion" },
      { sectionType: "COURSES", sortOrder: 3, variantName: "Numbered List", componentKey: "courses_numbered_list" },
      { sectionType: "COURSES", sortOrder: 4, variantName: "Split Rows", componentKey: "courses_split_rows" },
      { sectionType: "COURSES", sortOrder: 5, variantName: "Compact Tiles", componentKey: "courses_compact_tiles" },
      { sectionType: "FACULTY", sortOrder: 0, variantName: "Photo Cards", componentKey: "faculty_photo_cards" },
      { sectionType: "FACULTY", sortOrder: 1, variantName: "Roster List", componentKey: "faculty_roster_list" },
      { sectionType: "FACULTY", sortOrder: 2, variantName: "Circle Grid", componentKey: "faculty_circle_grid" },
      { sectionType: "FACULTY", sortOrder: 3, variantName: "Department Groups", componentKey: "faculty_department_groups" },
      { sectionType: "FACULTY", sortOrder: 4, variantName: "Overlay Tiles", componentKey: "faculty_overlay_tiles" },
      { sectionType: "FACULTY", sortOrder: 5, variantName: "Minimal Table", componentKey: "faculty_minimal_table" },
      { sectionType: "CONTACT", sortOrder: 0, variantName: "Split Map", componentKey: "contact_map_split" },
      { sectionType: "CONTACT", sortOrder: 1, variantName: "Centered", componentKey: "contact_centered" },
      { sectionType: "CONTACT", sortOrder: 2, variantName: "Form Only", componentKey: "contact_form_only" },
      { sectionType: "CONTACT", sortOrder: 3, variantName: "Full Width Map", componentKey: "contact_full_width_map" },
      { sectionType: "CONTACT", sortOrder: 4, variantName: "Cards Row", componentKey: "contact_cards_row" },
      { sectionType: "CONTACT", sortOrder: 5, variantName: "Dark Panel", componentKey: "contact_dark_panel" },
    ];

    const variantIds = new Map<string, string>();
    for (const v of VARIANT_SPECS) {
      const row = await prisma.sectionVariant.upsert({
        where: { componentKey: v.componentKey },
        update: { variantName: v.variantName, sectionType: v.sectionType as any, sortOrder: v.sortOrder },
        create: { componentKey: v.componentKey, variantName: v.variantName, sectionType: v.sectionType as any, sortOrder: v.sortOrder },
      });
      variantIds.set(v.componentKey, row.id);
    }

    const template = await prisma.template.upsert({
      where: { name: "College-Website" },
      update: {
        description: "Default official college website template",
        thumbnailUrl: "/template-brightwood.jpg",
        isPublished: true,
      },
      create: {
        name: "College-Website",
        description: "Default official college website template",
        thumbnailUrl: "/template-brightwood.jpg",
        isPublished: true,
      },
    });

    const types = ["HERO", "ABOUT", "COURSES", "FACULTY", "CONTACT"] as const;
    for (const st of types) {
      const leadVariantId = variantIds.get(
        st === "HERO"
          ? "hero_centered"
          : st === "ABOUT"
          ? "about_two_column"
          : st === "COURSES"
          ? "courses_card_grid"
          : st === "FACULTY"
          ? "faculty_photo_cards"
          : "contact_map_split",
      );

      await prisma.section.upsert({
        where: { templateId_sectionType: { templateId: template.id, sectionType: st as any } },
        update: { defaultOrder: types.indexOf(st) + 1, isRequired: st === "HERO" || st === "CONTACT", defaultVariantId: leadVariantId ?? null },
        create: { templateId: template.id, sectionType: st as any, defaultOrder: types.indexOf(st) + 1, isRequired: st === "HERO" || st === "CONTACT", defaultVariantId: leadVariantId ?? null },
      });
    }

    await prisma.serviceSecret
      .create({
        data: { name: TEMPLATES_INITIALIZED_MARKER, value: new Date().toISOString() },
      })
      .catch(() => {});

    console.log("[bootstrap] Successfully initialized College-Website default template and theme options.");
  } catch (err) {
    console.error("[bootstrap] reference data seed error:", (err as Error).message);
  }
}
