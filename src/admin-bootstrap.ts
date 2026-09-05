import { randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import { AdminUser, SystemSecret, Template } from "@/models";

export type BootstrapOutcome =
  | "idle"
  | "created"
  | "reset"
  | "matched"
  | "refused"
  | "failed";

let lastOutcome: BootstrapOutcome = "idle";

/**
 * Admin passwords this repository has published, plus a length floor.
 *
 * Kept beside `secret-hygiene.ts`'s list rather than merged into it because the
 * two answer different questions — that one guards signing keys, this one
 * guards a human credential — but both exist for the same reason: a value that
 * has appeared in a public file is burned, whatever it is later used for.
 */
const PUBLISHED_ADMIN_PASSWORDS = [
  "2008",
  "changeme",
  "change-me",
  "password",
  "admin",
  "replace-with-secure-admin-password",
  "college123",
  "greenfield123",
];

function isUnusableBootstrapPassword(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (lower.length < 12) return true;
  if (PUBLISHED_ADMIN_PASSWORDS.includes(lower)) return true;
  return /^(your-|<|replace-with|placeholder)/.test(lower);
}

export function bootstrapState() {
  return {
    varsSet: Boolean(
      process.env.ADMIN_BOOTSTRAP_EMAIL?.trim() &&
        process.env.ADMIN_BOOTSTRAP_PASSWORD,
    ),
    lastRun: lastOutcome,
  };
}

/**
 * The address the first Super Admin is created at when none is configured.
 *
 * There is deliberately no password beside it any more. This constant used to
 * read `{ email: "admin@xite.co.in", password: "2008" }`, and that pair was
 * applied on *every* boot — the "will not be applied again" marker below was
 * written but never read — so a deployment that had rotated its admin password
 * had it silently reset to a four-digit literal published in this repository on
 * the next container restart. `adminLogin` accepted the same literal directly,
 * which made it a universal key rather than merely a weak one.
 *
 * A first administrator is still created when nothing is configured, because a
 * platform whose admin panel cannot be opened is a platform nobody can operate.
 * The password is now generated per deployment and printed once to the server
 * log, which is an operator-only channel — it is not in the image, not in git,
 * and not the same on two installations.
 */
const DEFAULT_ADMIN_EMAIL = "admin@xite.co.in";

const DEFAULT_APPLIED_MARKER = "admin_default_applied";

/**
 * A password worth generating: 32 base64url characters of CSPRNG output. Long
 * enough that the one log line below is the only place it can come from.
 */
function generatedPassword(): string {
  return randomBytes(24).toString("base64url");
}

export async function bootstrapAdmin() {
  const envEmail = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const envPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const fromEnv = Boolean(envEmail && envPassword);

  const email = fromEnv ? envEmail! : DEFAULT_ADMIN_EMAIL;

  try {
    /**
     * Without configuration, this runs exactly once per database.
     *
     * The marker is read now as well as written. Re-running the unconfigured
     * branch is what turned a first-boot convenience into a standing password
     * reset, so a database that has already been bootstrapped is left alone —
     * whatever the administrator has since changed their password to stays.
     */
    if (!fromEnv) {
      const alreadyApplied = await SystemSecret.findOne({
        name: DEFAULT_APPLIED_MARKER,
      }).catch(() => null);

      if (alreadyApplied) {
        lastOutcome = "matched";
        await bootstrapTemplates();
        return;
      }
    }

    const password = fromEnv ? envPassword! : generatedPassword();

    if (password.length < 1) {
      lastOutcome = "refused";
      console.error("[admin] bootstrap refused — password is empty.");
      return;
    }

    /**
     * A configured password that is a known placeholder is refused outright.
     *
     * Creating an administrator whose password is a string from this
     * repository's own documentation is worse than creating none: the panel
     * opens, looks configured, and is open to whoever read the file.
     */
    if (fromEnv && isUnusableBootstrapPassword(password)) {
      lastOutcome = "refused";
      console.error(
        "[admin] bootstrap refused — ADMIN_BOOTSTRAP_PASSWORD is a known " +
          "placeholder or shorter than 12 characters. Generate one with " +
          "`openssl rand -base64 24` and redeploy.",
      );
      return;
    }

    const existing = await AdminUser.findOne({ email });

    if (!existing && !fromEnv) {
      // The generated password exists only here and in this one log line.
      console.warn(
        [
          "",
          "  FIRST SUPER ADMIN CREATED — PASSWORD SHOWN ONCE",
          "",
          `    email:    ${email}`,
          `    password: ${password}`,
          "",
          "  Sign in, change it, and do not rely on this line surviving in the",
          "  log. It is not printed again on any later boot.",
          "",
        ].join("\n"),
      );
    }

    if (!existing) {
      try {
        await AdminUser.create({
          email,
          passwordHash: await bcrypt.hash(password, 12),
          role: "SUPER_ADMIN",
        });
        lastOutcome = "created";
        console.log(`[admin] created Super Admin: ${email}`);
      } catch (err: any) {
        if (err?.code === 11000) {
          lastOutcome = "matched";
          console.log(`[admin] ${email} already exists.`);
        } else {
          throw err;
        }
      }
    } else if (!fromEnv) {
      /**
       * An administrator already exists and nothing was configured, so there is
       * nothing to apply. This branch used to overwrite their stored hash with
       * the committed default on every single boot.
       */
      lastOutcome = "matched";
    } else if (await bcrypt.compare(password, existing.passwordHash)) {
      lastOutcome = "matched";
      console.log(`[admin] ${email} already has this password.`);
    } else {
      existing.passwordHash = await bcrypt.hash(password, 12);
      await existing.save();
      lastOutcome = "reset";
      console.log(`[admin] reset the password for ${email} from the environment.`);
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

    await bootstrapTemplates();
  } catch (error) {
    lastOutcome = "failed";
    console.error("[admin] bootstrap failed:", (error as Error).message);
  }
}

/**
 * The marker that says the reference-template seed has already run.
 *
 * Exported because `deleteAllTemplates()` has to set it: emptying the library
 * without it leaves a deployment that refills itself on the next restart, and
 * a second copy of this string in that file would be a typo away from doing
 * nothing at all — silently, and only visible one container restart later.
 */
export const TEMPLATES_INITIALIZED_MARKER = "templates_initial_seed_done";

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

    /*
     * Six theme palettes and five font packs used to be seeded here, into the
     * `ThemePalette` and `ThemeFont` collections.
     *
     * Nothing has ever read either collection. The platform's themes are the
     * four in `lib/editor-themes.ts` — the only ones the renderer ships
     * components for, and the list both services validate against — and its
     * fonts are the three beside them. So this wrote a second, contradictory
     * catalogue of themes on every fresh deployment: "Heritage Maroon" and
     * "Campus Green" were rows in the database that no tenant could select and
     * no page could render.
     *
     * That is not merely dead weight. A plausible-looking theme table is how a
     * theme id nobody ships gets written onto a college — the frontend's
     * open-access fallback invented `themePaletteId: "classic-navy"` for
     * exactly this reason, and a site carrying an unrenderable id loads with no
     * styling at all.
     *
     * The collections and their models are left in place: rows already written
     * on existing deployments are harmless, and dropping a collection is a
     * migration, not a cleanup. What stops here is creating more of them.
     */

    const INITIAL_SECTION_TEMPLATES = [
      {
        name: "College-Website",
        category: "header",
        description: "Default official college website template",
        thumbnailUrl: "/template-brightwood.jpg",
        isPublished: true,
      },
      {
        name: "Header Navigation 1",
        category: "header",
        description: "Dark Navy modern header",
        code: `<header style="background: #0d1527; color: #ffffff; padding: 18px 40px; display: flex; align-items: center; justify-content: space-between; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;"><div style="display: flex; align-items: center; gap: 12px;"><div style="width: 40px; height: 40px; border-radius: 10px; background: #2563eb; color: #ffffff; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 18px;">🎓</div><span style="font-size: 20px; font-weight: 900; color: #ffffff;">CAMPUS PORTAL</span></div><nav style="display: flex; gap: 24px; font-size: 14px; font-weight: 700;"><a href="#about" style="color: #cbd5e1; text-decoration: none;">About</a><a href="#courses" style="color: #cbd5e1; text-decoration: none;">Academics</a><a href="#admissions" style="color: #cbd5e1; text-decoration: none;">Admissions</a><a href="#placements" style="color: #cbd5e1; text-decoration: none;">Placements</a><a href="#contact" style="color: #cbd5e1; text-decoration: none;">Contact</a></nav><a href="#apply" style="background: #2563eb; color: #ffffff; padding: 10px 24px; border-radius: 10px; font-size: 13px; font-weight: 800; text-decoration: none;">Apply Now</a></header>`,
        isPublished: true,
      },
      {
        name: "Header Navigation 2 - Seoul National University",
        category: "header",
        description: "Seoul National University Translucent Gold Header",
        code: `<header style="width: 100%; min-height: 120px; display: flex; align-items: center; justify-content: center; padding: 20px 40px; position: relative; background: linear-gradient(rgba(18, 22, 33, 0.90), rgba(18, 22, 33, 0.90)), url('https://images.unsplash.com/photo-1497366216548-37526070297c?q=80&w=1200&auto=format&fit=crop') center/cover no-repeat; border-top: 1px solid rgba(255, 255, 255, 0.25); border-bottom: 1.5px solid rgba(212, 175, 55, 0.7); box-sizing: border-box;"><div style="width: 100%; max-width: 1400px; display: flex; align-items: center; justify-content: space-between; gap: 35px; box-sizing: border-box;"><ul style="display: flex; align-items: center; list-style: none; gap: 35px; margin: 0; padding: 0;"><li><a href="#academics" style="color: #ffffff; text-decoration: none; font-size: 13.5px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase;">ACADEMICS</a></li><li><a href="#research" style="color: #ffffff; text-decoration: none; font-size: 13.5px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase;">RESEARCH</a></li><li><a href="#admissions" style="color: #ffffff; text-decoration: none; font-size: 13.5px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase;">ADMISSIONS</a></li></ul><a href="#" style="display: flex; align-items: center; gap: 14px; text-decoration: none; color: #ffffff;"><svg style="height: 52px; width: auto; fill: #ffffff; flex-shrink: 0;" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="M32 4L8 16v18c0 14.5 10.2 26.2 24 30 13.8-3.8 24-15.5 24-30V16L32 4zm0 6.2l18 9v14.8c0 11.6-8.1 21-18 24.1-9.9-3.1-18-12.5-18-24.1V19.2l18-9z"/><path d="M32 20a10 10 0 100 20 10 10 0 000-20zm0 4a6 6 0 110 12 6 6 0 010-12z"/></svg><div style="display: flex; flex-direction: column; text-align: left;"><span style="font-size: 22px; font-weight: 400; letter-spacing: 2.5px; line-height: 1; font-family: Georgia, serif; color: #ffffff;">SEOUL</span><span style="font-size: 10px; letter-spacing: 1.5px; font-weight: 600; margin-top: 4px; color: #d4af37; line-height: 1.2;">NATIONAL<br />UNIVERSITY</span></div></a><ul style="display: flex; align-items: center; list-style: none; gap: 35px; margin: 0; padding: 0;"><li><a href="#snu-now" style="color: #ffffff; text-decoration: none; font-size: 13.5px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase;">SNU NOW</a></li><li><a href="#campus-life" style="color: #ffffff; text-decoration: none; font-size: 13.5px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase;">CAMPUS LIFE</a></li><li><a href="#about-snu" style="color: #ffffff; text-decoration: none; font-size: 13.5px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase;">ABOUT SNU</a></li></ul></div></header>`,
        isPublished: true,
      },
      {
        name: "Hero Banner 1",
        category: "hero",
        description: "Centered Admissions Hero",
        code: `<section style="background: #ffffff; color: #0f172a; padding: 90px 24px; text-align: center; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;"><div style="max-width: 960px; margin: 0 auto;"><span style="background: #ffe4e6; border: 1px solid #f43f5e; color: #e11d48; padding: 6px 20px; border-radius: 9999px; font-size: 12px; font-weight: 800;">ADMISSIONS OPEN 2026-2027</span><h1 style="font-size: 56px; font-weight: 900; margin-top: 24px; color: #0f172a;"><span style="color: #0f172a;">Empowering</span> <span style="color: #2563eb;">Minds,</span> <span style="color: #0f172a;">Shaping</span> <span style="color: #2563eb;">Tomorrow's</span> <span style="color: #0f172a;">Leaders</span></h1><p style="font-size: 18px; color: #475569; margin-top: 20px;"><span style="color: #475569;">Join</span> <span style="color: #0284c7;">a</span> <span style="color: #475569;">world-class</span> <span style="color: #0284c7;">academic</span> <span style="color: #475569;">community</span> <span style="color: #0284c7;">dedicated</span> <span style="color: #475569;">to</span> <span style="color: #0284c7;">innovation,</span> <span style="color: #475569;">groundbreaking</span> <span style="color: #0284c7;">research,</span> <span style="color: #475569;">and</span> <span style="color: #0284c7;">personal</span> <span style="color: #475569;">growth.</span></p><div style="margin-top: 36px; display: flex; justify-content: center; gap: 16px;"><a href="#apply" style="background: #ef4444; color: #ffffff; padding: 14px 36px; border-radius: 12px; font-weight: 800; text-decoration: none;">Apply Online</a></div></div></section>`,
        isPublished: true,
      },
      {
        name: "Upcoming Campus Events 1",
        category: "events",
        description: "Calendar Cards Layout",
        code: `<section style="background: #ffffff; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;"><div style="max-width: 1000px; margin: 0 auto;"><div style="text-align: center;"><span style="color: #2563eb; font-size: 12px; font-weight: 900; text-transform: uppercase;">CAMPUS CALENDAR</span><h2 style="font-size: 36px; font-weight: 900; margin-top: 8px;">Upcoming Events & Conferences</h2></div><div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 40px;"><div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 24px; border-radius: 16px;"><div style="font-size: 12px; font-weight: 900; color: #ef4444;">MARCH 15, 2026</div><h4 style="font-size: 18px; font-weight: 900; margin-top: 8px;">International Tech Symposium</h4><p style="font-size: 13px; color: #64748b; margin-top: 6px;">Keynote sessions by global AI pioneers.</p></div><div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 24px; border-radius: 16px;"><div style="font-size: 12px; font-weight: 900; color: #2563eb;">APRIL 02, 2026</div><h4 style="font-size: 18px; font-weight: 900; margin-top: 8px;">Annual Cultural Fest 2026</h4><p style="font-size: 13px; color: #64748b; margin-top: 6px;">Music concerts, dance competitions & expo.</p></div><div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 24px; border-radius: 16px;"><div style="font-size: 12px; font-weight: 900; color: #10b981;">MAY 10, 2026</div><h4 style="font-size: 18px; font-weight: 900; margin-top: 8px;">National Placement Fair</h4><p style="font-size: 13px; color: #64748b; margin-top: 6px;">On-campus recruitment by 200+ MNCs.</p></div></div></div></section>`,
        isPublished: true,
      },
      {
        name: "Placement & Top Recruiters 1",
        category: "placements",
        description: "3 Metric Box Placement Banner",
        code: `<section style="background: #0f172a; color: #ffffff; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;"><div style="max-width: 1000px; margin: 0 auto; text-align: center;"><span style="color: #38bdf8; font-size: 12px; font-weight: 900; text-transform: uppercase;">CAREER PLACEMENTS</span><h2 style="font-size: 38px; font-weight: 900; margin-top: 8px; color: #ffffff;">Placement Records & Top Recruiters</h2><div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 40px;"><div style="background: #1e293b; padding: 32px; border-radius: 20px; border: 1px solid #334155;"><h3 style="font-size: 40px; font-weight: 900; color: #38bdf8; margin: 0;">₹52 LPA</h3><p style="font-size: 13px; color: #94a3b8; font-weight: 700; margin-top: 8px;">Highest National Package</p></div><div style="background: #1e293b; padding: 32px; border-radius: 20px; border: 1px solid #334155;"><h3 style="font-size: 40px; font-weight: 900; color: #38bdf8; margin: 0;">₹12.4 LPA</h3><p style="font-size: 13px; color: #94a3b8; font-weight: 700; margin-top: 8px;">Average Campus Salary</p></div><div style="background: #1e293b; padding: 32px; border-radius: 20px; border: 1px solid #334155;"><h3 style="font-size: 40px; font-weight: 900; color: #38bdf8; margin: 0;">450+</h3><p style="font-size: 13px; color: #94a3b8; font-weight: 700; margin-top: 8px;">Recruiting Partners</p></div></div></div></section>`,
        isPublished: true,
      },
      {
        name: "Courses / Program 1",
        category: "courses",
        description: "Degree Cards Layout",
        code: `<section style="background: #ffffff; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;"><div style="max-width: 1100px; margin: 0 auto;"><div style="text-align: center;"><span style="color: #2563eb; font-size: 12px; font-weight: 900; text-transform: uppercase;">ACADEMIC DEGREES</span><h2 style="font-size: 36px; font-weight: 900; margin-top: 8px;">Explore Our Degree Programs</h2></div><div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 48px;"><div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 28px; border-radius: 20px;"><h3 style="font-size: 18px; font-weight: 900; color: #0f172a;">B.Tech Computer Science</h3><p style="font-size: 13px; color: #64748b; margin-top: 8px;">4 Years Undergraduate Degree in AI, ML & Software Systems.</p><a href="#apply" style="color: #2563eb; font-size: 13px; font-weight: 800; text-decoration: none; display: inline-block; margin-top: 16px;">View Curriculum →</a></div><div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 28px; border-radius: 20px;"><h3 style="font-size: 18px; font-weight: 900; color: #0f172a;">M.Tech Data Science</h3><p style="font-size: 13px; color: #64748b; margin-top: 8px;">2 Years Postgraduate Specialization in Big Data Analytics.</p><a href="#apply" style="color: #2563eb; font-size: 13px; font-weight: 800; text-decoration: none; display: inline-block; margin-top: 16px;">View Curriculum →</a></div><div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 28px; border-radius: 20px;"><h3 style="font-size: 18px; font-weight: 900; color: #0f172a;">MBA Business Analytics</h3><p style="font-size: 13px; color: #64748b; margin-top: 8px;">2 Years Management Program in Finance, Marketing & Operations.</p><a href="#apply" style="color: #2563eb; font-size: 13px; font-weight: 800; text-decoration: none; display: inline-block; margin-top: 16px;">View Curriculum →</a></div></div></div></section>`,
        isPublished: true,
      },
      {
        name: "Footer 1",
        category: "footer",
        description: "Dark Multi-column Footer",
        code: `<footer style="background: #090d16; color: #94a3b8; padding: 60px 40px 30px 40px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box; border-top: 1px solid rgba(255,255,255,0.08);"><div style="max-width: 1100px; margin: 0 auto; display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 40px;"><div><div style="font-size: 20px; font-weight: 900; color: #ffffff;">CAMPUS PORTAL</div><p style="font-size: 13px; color: #64748b; margin-top: 12px;">NIRF Top Ranked Autonomous College of Engineering.</p></div><div><div style="font-size: 13px; font-weight: 900; color: #ffffff;">Quick Links</div><div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px; font-size: 13px;"><a href="#about" style="color: #94a3b8; text-decoration: none;">About Us</a><a href="#courses" style="color: #94a3b8; text-decoration: none;">Academics</a></div></div><div><div style="font-size: 13px; font-weight: 900; color: #ffffff;">Admissions</div><div style="display: flex; flex-direction: column; gap: 8px; margin-top: 12px; font-size: 13px;"><a href="#apply" style="color: #94a3b8; text-decoration: none;">Apply Online</a></div></div><div><div style="font-size: 13px; font-weight: 900; color: #ffffff;">Address</div><p style="font-size: 12px; color: #64748b; margin-top: 12px;">Grand Trunk Road, Tech City, India</p></div></div><div style="max-width: 1100px; margin: 40px auto 0 auto; padding-top: 24px; border-top: 1px solid rgba(255,255,255,0.05); text-align: center; font-size: 12px; color: #64748b;">© 2026 Campus Portal. All rights reserved.</div></footer>`,
        isPublished: true,
      },
    ];

    for (const item of INITIAL_SECTION_TEMPLATES) {
      await Template.findOneAndUpdate(
        { name: item.name },
        item,
        { upsert: true }
      );
    }

    await SystemSecret.findOneAndUpdate(
      { name: TEMPLATES_INITIALIZED_MARKER },
      { name: TEMPLATES_INITIALIZED_MARKER, value: new Date().toISOString() },
      { upsert: true }
    );

    console.log(`[bootstrap] Successfully initialized ${INITIAL_SECTION_TEMPLATES.length} reference templates and theme options.`);
  } catch (err) {
    console.error("[bootstrap] reference data seed error:", (err as Error).message);
  }
}
