/**
 * Empties the admin section library, and nothing else.
 *
 *     node scripts/wipe-section-library.mjs            # report only, deletes nothing
 *     node scripts/wipe-section-library.mjs --yes      # actually delete
 *
 * ── What it touches ────────────────────────────────────────────────────────
 *
 *   DELETES   templates                     the admin section designs
 *   CLEARS    colleges.templateId           only where it points at a deleted row
 *   ENSURES   system_secrets marker         so a restart does not re-seed
 *
 *   NEVER TOUCHES
 *             colleges                      the tenant records
 *             colleges.websiteConfig        every tenant's draft pages + sections
 *             colleges.publishedConfig      every tenant's live site
 *             colleges.users                accounts and passwords
 *             access_requests               the approval queue
 *             admin_users                   your Super Admin
 *
 * ── Why this exists rather than the three scripts beside it ────────────────
 *
 * `wipe-all-except-admin.mjs`, `clear-all-templates.mjs` and
 * `clear-all-users.mjs` are all written against the PostgreSQL schema this
 * platform stopped using — `DELETE FROM college_sections`, through a `pg` pool.
 * Against the live MongoDB they do not do what they say. And
 * `wipe-all-except-admin.mjs` ends by recreating the Super Admin with the
 * password `2008`, which is the hardcoded universal credential this codebase's
 * own security fix removed and then blacklisted by name in
 * `PUBLISHED_ADMIN_PASSWORDS`. Running it would reintroduce the worst
 * vulnerability the platform has had.
 *
 * ── Why it reports before it deletes ───────────────────────────────────────
 *
 * Deleting a template is not free for a site that is already live. The
 * sanitiser strips `<script>` from tenant section markup on write, and
 * `restoreTemplateScripts` re-injects it on read from the `Template` row the
 * section came from. So a section whose *content is assembled by its script* —
 * a slider that builds its slides, a counter that fills its numbers — renders
 * as an empty rectangle once its template is gone. Plain HTML and CSS sections
 * are unaffected, because their markup is stored on the section itself.
 *
 * That distinction cannot be guessed from outside the database, so the default
 * run measures it: which templates are referenced by real sections, which of
 * those carry scripts, and how many colleges would notice. Deleting requires
 * reading that and passing `--yes`.
 */

import "dotenv/config";
import mongoose from "mongoose";

const CONFIRM = process.argv.includes("--yes");
const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;

if (!uri) {
  console.error("[wipe] MONGODB_URI is not set.");
  process.exit(2);
}
if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
  console.error("[wipe] MONGODB_URI is not a MongoDB connection string. Refusing to run.");
  process.exit(2);
}

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;

const SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script\s*>/i;

/** The marker `bootstrapTemplates()` checks before it seeds reference templates. */
const SEED_MARKER = "templates_initial_seed_done";

async function main() {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20_000 });
  const db = mongoose.connection.db;
  console.log(dim(`[wipe] connected to ${mongoose.connection.name}`));

  const templates = db.collection("templates");
  const colleges = db.collection("colleges");
  const secrets = db.collection("system_secrets");

  const rows = await templates.find({}).project({ name: 1, code: 1, archivedAt: 1 }).toArray();

  if (rows.length === 0) {
    console.log(green("\n[wipe] the section library is already empty. Nothing to do."));
    return;
  }

  /**
   * Which template ids real sections point at.
   *
   * Both configs, because the draft is what the editor reads and the published
   * copy is what visitors are served — a template referenced only by the
   * published config still matters, and is the one whose loss is visible to
   * the public rather than to the tenant.
   */
  const referenced = new Map(); // templateId -> { colleges:Set, sections:number, published:boolean }

  const cursor = colleges.find({}).project({
    name: 1,
    subdomain: 1,
    templateId: 1,
    "websiteConfig.pages": 1,
    "publishedConfig.pages": 1,
  });

  let collegeCount = 0;
  const danglingTemplateId = [];

  for await (const college of cursor) {
    collegeCount += 1;

    const note = (id, isPublished) => {
      if (typeof id !== "string" || !id) return;
      const entry = referenced.get(id) ?? { colleges: new Set(), sections: 0, published: false };
      entry.colleges.add(college.subdomain || String(college._id));
      entry.sections += 1;
      if (isPublished) entry.published = true;
      referenced.set(id, entry);
    };

    for (const [config, isPublished] of [
      [college.websiteConfig, false],
      [college.publishedConfig, true],
    ]) {
      for (const page of config?.pages ?? []) {
        for (const section of page?.sections ?? []) note(section?.templateId, isPublished);
      }
    }

    if (college.templateId) danglingTemplateId.push(college.subdomain || String(college._id));
  }

  /* ── The report ───────────────────────────────────────────────────────── */

  const withScript = rows.filter((r) => typeof r.code === "string" && SCRIPT_BLOCK.test(r.code));
  const scriptIds = new Set(withScript.map((r) => String(r._id)));

  const atRisk = [...referenced.entries()]
    .filter(([id]) => scriptIds.has(id))
    .map(([id, entry]) => {
      const row = rows.find((r) => String(r._id) === id);
      return { id, name: row?.name ?? "(unknown)", ...entry };
    });

  console.log(`\n${bold("Section library")}`);
  console.log(`  templates                  ${rows.length}`);
  console.log(`  …carrying <script>         ${withScript.length}`);
  console.log(`  …referenced by a section   ${[...referenced.keys()].filter((id) => rows.some((r) => String(r._id) === id)).length}`);
  console.log(`\n${bold("Tenants")}`);
  console.log(`  colleges scanned           ${collegeCount}`);
  console.log(`  colleges with templateId   ${danglingTemplateId.length}`);

  if (atRisk.length === 0) {
    console.log(
      `\n${green("No live section depends on a template script.")}\n` +
        dim("  Every referenced section stores its own markup, so deleting the\n") +
        dim("  library changes nothing a visitor can see."),
    );
  } else {
    console.log(`\n${red(bold("Sections that will go blank if you delete these:"))}`);
    for (const t of atRisk) {
      console.log(
        `  ${red("•")} ${bold(t.name)} ${dim(t.id)}\n` +
          `      ${t.sections} section(s) across ${t.colleges.size} college(s)` +
          (t.published ? red("  — INCLUDING A PUBLISHED, LIVE SITE") : dim("  — draft only")),
      );
      console.log(dim(`      ${[...t.colleges].slice(0, 6).join(", ")}${t.colleges.size > 6 ? ", …" : ""}`));
    }
    console.log(
      dim(
        "\n  Their markup survives; the script that assembles their content does\n" +
          "  not. Re-uploading a template does not fix them either — the section\n" +
          "  instance points at the old id.",
      ),
    );
  }

  if (!CONFIRM) {
    console.log(
      `\n${amber(bold("Report only — nothing was deleted."))}\n` +
        dim("  Re-run with --yes to delete the templates listed above."),
    );
    return;
  }

  /* ── The deletion ─────────────────────────────────────────────────────── */

  console.log(`\n${bold("Deleting…")}`);

  const deleted = await templates.deleteMany({});
  console.log(`  templates deleted          ${deleted.deletedCount}`);

  /**
   * A college pointing at a template that no longer exists is a broken
   * reference, and `adminOverview` counts it as "has a template". Cleared so
   * the panel's own figures stay true.
   *
   * Section-level `templateId` is deliberately left alone: it is the section's
   * provenance and the key the variant cycle uses, the markup does not depend
   * on it, and rewriting every tenant's config is a far larger write than this
   * task asked for.
   */
  const unlinked = await colleges.updateMany(
    { templateId: { $ne: null } },
    { $set: { templateId: null } },
  );
  console.log(`  colleges unlinked          ${unlinked.modifiedCount}`);

  /**
   * Without this, the library refills itself.
   *
   * `bootstrapTemplates()` runs on every boot and re-seeds its reference
   * templates when it finds zero templates *and* no marker. An empty library
   * plus a container restart would otherwise put the old set straight back,
   * which is the opposite of starting fresh.
   */
  const marker = await secrets.updateOne(
    { name: SEED_MARKER },
    { $set: { name: SEED_MARKER, value: new Date().toISOString() } },
    { upsert: true },
  );
  console.log(
    `  re-seed marker             ${marker.upsertedCount ? "created" : "already present"} ` +
      dim("(stops bootstrap refilling the library)"),
  );

  const remaining = await templates.countDocuments();
  const collegesLeft = await colleges.countDocuments();

  console.log(`\n${bold("After")}`);
  console.log(`  templates                  ${remaining}`);
  console.log(`  colleges                   ${collegesLeft} ${dim("(untouched)")}`);
  console.log(
    `\n${green("Done.")} ${dim("Upload new sections in Admin › Templates & Sections.")}`,
  );
}

main()
  .catch((error) => {
    console.error(red("\n[wipe] failed:"), error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => null);
  });
