import bcrypt from "bcryptjs";
import { AdminUser, SystemSecret, ThemePalette, ThemeFont, Template } from "@/models";

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
    varsSet: Boolean(
      process.env.ADMIN_BOOTSTRAP_EMAIL?.trim() &&
        process.env.ADMIN_BOOTSTRAP_PASSWORD,
    ),
    lastRun: lastOutcome,
  };
}

const DEFAULT_ADMIN = {
  email: "admin@xite.co.in",
  password: "2008",
};

const DEFAULT_APPLIED_MARKER = "admin_default_applied";

export async function bootstrapAdmin() {
  const envEmail = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const envPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const fromEnv = Boolean(envEmail && envPassword);

  const email = fromEnv ? envEmail! : DEFAULT_ADMIN.email;
  const password = fromEnv ? envPassword! : DEFAULT_ADMIN.password;

  try {
    if (password.length < 1) {
      lastOutcome = "refused";
      console.error("[admin] bootstrap refused — password is empty.");
      return;
    }

    const existing = await AdminUser.findOne({ email });

    if (!existing) {
      await AdminUser.create({
        email,
        passwordHash: await bcrypt.hash(password, 12),
        role: "SUPER_ADMIN",
      });
      lastOutcome = "created";
      console.log(`[admin] created Super Admin: ${email}`);
    } else if (await bcrypt.compare(password, existing.passwordHash)) {
      lastOutcome = "matched";
      console.log(`[admin] ${email} already has this password.`);
    } else {
      existing.passwordHash = await bcrypt.hash(password, 12);
      await existing.save();
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

    await SystemSecret.findOneAndUpdate(
      { name: DEFAULT_APPLIED_MARKER },
      { name: DEFAULT_APPLIED_MARKER, value: new Date().toISOString() },
      { upsert: true }
    ).catch(() => {});

    console.warn(
      `[admin] This deployment is using the committed default password for ` +
        `${email}. It will not be applied again.`,
    );

    await bootstrapTemplates();
  } catch (error) {
    lastOutcome = "failed";
    console.error("[admin] bootstrap failed:", (error as Error).message);
  }
}

const TEMPLATES_INITIALIZED_MARKER = "templates_initial_seed_done";

export async function bootstrapTemplates() {
  try {
    const marker = await SystemSecret.findOne({ name: TEMPLATES_INITIALIZED_MARKER });
    if (marker) return;

    const templateCount = await Template.countDocuments();
    if (templateCount > 0) {
      await SystemSecret.findOneAndUpdate(
        { name: TEMPLATES_INITIALIZED_MARKER },
        { name: TEMPLATES_INITIALIZED_MARKER, value: new Date().toISOString() },
        { upsert: true }
      );
      return;
    }

    console.log("[bootstrap] First-time setup: 0 templates found in MongoDB Atlas. Seeding initial reference templates...");

    const PALETTES = [
      { name: "Academic Blue", paletteColors: { primary: "#1E3A8A", secondary: "#3B82F6", accent: "#F59E0B", dark: "#0F172A", light: "#F8FAFC" } },
      { name: "Heritage Maroon", paletteColors: { primary: "#7F1D1D", secondary: "#B91C1C", accent: "#D4A017", dark: "#1C1917", light: "#FEF7ED" } },
      { name: "Campus Green", paletteColors: { primary: "#14532D", secondary: "#16A34A", accent: "#FACC15", dark: "#0B1F16", light: "#F0FDF4" } },
      { name: "Midnight Indigo", paletteColors: { primary: "#312E81", secondary: "#6366F1", accent: "#10B981", dark: "#09090B", light: "#EEF2FF" } },
      { name: "Sunset Sapphire", paletteColors: { primary: "#0369A1", secondary: "#0284C7", accent: "#F97316", dark: "#0F172A", light: "#F0F9FF" } },
      { name: "Editorial Plum", paletteColors: { primary: "#581C87", secondary: "#9333EA", accent: "#EAB308", dark: "#18181B", light: "#FAF5FF" } },
    ];

    const FONT_PACKS = [
      { name: "Classic Serif", headingFont: "Playfair Display", bodyFont: "Source Sans 3" },
      { name: "Modern Sans", headingFont: "Poppins", bodyFont: "Inter" },
      { name: "Editorial Elegance", headingFont: "Cormorant Garamond", bodyFont: "Plus Jakarta Sans" },
      { name: "Tech Precision", headingFont: "Outfit", bodyFont: "Roboto" },
      { name: "Academic Prestige", headingFont: "Merriweather", bodyFont: "Open Sans" },
    ];

    for (const p of PALETTES) {
      await ThemePalette.findOneAndUpdate({ name: p.name }, p, { upsert: true });
    }
    for (const f of FONT_PACKS) {
      await ThemeFont.findOneAndUpdate({ name: f.name }, f, { upsert: true });
    }

    await Template.findOneAndUpdate(
      { name: "College-Website" },
      {
        name: "College-Website",
        description: "Default official college website template",
        thumbnailUrl: "/template-brightwood.jpg",
        isPublished: true,
      },
      { upsert: true }
    );

    await SystemSecret.findOneAndUpdate(
      { name: TEMPLATES_INITIALIZED_MARKER },
      { name: TEMPLATES_INITIALIZED_MARKER, value: new Date().toISOString() },
      { upsert: true }
    );

    console.log("[bootstrap] Successfully initialized College-Website default template and theme options.");
  } catch (err) {
    console.error("[bootstrap] reference data seed error:", (err as Error).message);
  }
}
