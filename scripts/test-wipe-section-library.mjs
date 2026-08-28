/**
 * Proves what `wipe-section-library.mjs` deletes, and — more importantly —
 * what it does not.
 *
 *     node scripts/test-wipe-section-library.mjs
 *
 * Runs against its own throwaway MongoDB, seeded to look like the real thing:
 * a plain template, a template whose content is built by its script, a college
 * whose draft *and published* site reference both, plus users, an access
 * request and an admin account that must all survive untouched.
 *
 * This exists because the script it tests is the one destructive tool in this
 * repository that is meant to be pointed at production. The three that came
 * before it are all written against a PostgreSQL schema the platform no longer
 * uses, and one of them ends by resetting the Super Admin password to `2008`.
 * A destructive script nobody has watched work is indistinguishable from those
 * until the moment somebody runs it.
 */

import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient, ObjectId } from "mongodb";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "wipe-section-library.mjs");

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

let passed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ${green("✓")} ${name}`);
  } else {
    failures.push(name);
    console.log(`  ${red("✗")} ${name}${detail ? ` ${dim("— " + detail)}` : ""}`);
  }
}

const PLAIN_CODE = '<section class="hero"><h1>Welcome</h1></section>';
const SCRIPTED_CODE =
  '<section id="stats"></section><script>document.getElementById("stats").innerHTML="<b>1200</b>";</script>';

async function seed(uri) {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("xite_test");

  const plainId = new ObjectId();
  const scriptedId = new ObjectId();
  const orphanId = new ObjectId();

  await db.collection("templates").insertMany([
    { _id: plainId, name: "Hero Plain", category: "hero", isPublished: true, archivedAt: null, code: PLAIN_CODE },
    { _id: scriptedId, name: "Stats Counter", category: "highlights", isPublished: true, archivedAt: null, code: SCRIPTED_CODE },
    // Referenced by nobody — the case that is genuinely free to delete.
    { _id: orphanId, name: "Unused Gallery", category: "gallery", isPublished: true, archivedAt: null, code: "<section>gallery</section>" },
  ]);

  await db.collection("colleges").insertMany([
    {
      name: "Test College", subdomain: "testcollege", status: "ACTIVE", isDemo: false,
      templateId: plainId.toString(),
      users: [{ id: "u1", email: "owner@testcollege.ac.in", passwordHash: "$2a$12$notarealhash", status: "ACTIVE" }],
      websiteConfig: { pages: [{ slug: "/home", title: "Home", sections: [
        { id: "s1", templateId: plainId.toString(), code: PLAIN_CODE, sortOrder: 0 },
        { id: "s2", templateId: scriptedId.toString(), code: '<section id="stats"></section>', sortOrder: 1 },
      ] }] },
      // The published copy references the scripted template too — the case
      // whose breakage is visible to the public, not just to the tenant.
      publishedConfig: { pages: [{ slug: "/home", title: "Home", sections: [
        { id: "s2", templateId: scriptedId.toString(), code: '<section id="stats"></section>', sortOrder: 0 },
      ] }] },
      publishedVersion: 3,
    },
    {
      name: "Plain College", subdomain: "plaincollege", status: "ACTIVE", isDemo: false,
      templateId: null,
      users: [{ id: "u2", email: "owner@plaincollege.ac.in", passwordHash: "$2a$12$notarealhash", status: "ACTIVE" }],
      websiteConfig: { pages: [{ slug: "/home", title: "Home", sections: [
        { id: "s3", templateId: plainId.toString(), code: PLAIN_CODE, sortOrder: 0 },
      ] }] },
      publishedConfig: null,
      publishedVersion: 0,
    },
  ]);

  await db.collection("access_requests").insertOne({
    collegeName: "Waiting College", applicantEmail: "waiting@x.ac.in", status: "PENDING",
    applicantPhone: "+91 90000 00000", createdAt: new Date(),
  });

  await db.collection("admin_users").insertOne({
    email: "admin@local.test", passwordHash: "$2a$12$adminhash", role: "SUPER_ADMIN",
  });

  await client.close();
  return { plainId: plainId.toString(), scriptedId: scriptedId.toString() };
}

function run(uri, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, MONGODB_URI: uri, DATABASE_URL: "" },
    encoding: "utf8",
    cwd: path.join(HERE, ".."),
  });
}

async function snapshot(uri) {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("xite_test");
  const out = {
    templates: await db.collection("templates").countDocuments(),
    colleges: await db.collection("colleges").countDocuments(),
    requests: await db.collection("access_requests").countDocuments(),
    admins: await db.collection("admin_users").countDocuments(),
    marker: await db.collection("system_secrets").countDocuments({ name: "templates_initial_seed_done" }),
    testCollege: await db.collection("colleges").findOne({ subdomain: "testcollege" }),
  };
  await client.close();
  return out;
}

async function main() {
  const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180_000 } });
  const uri = mongo.getUri("xite_test");

  try {
    await seed(uri);

    /* ── Report mode must change nothing ────────────────────────────────── */
    console.log("\n\x1b[1mReport mode\x1b[0m");
    const report = run(uri);
    const out = report.stdout || "";

    check("exits cleanly", report.status === 0, `status ${report.status} ${report.stderr?.slice(0, 120)}`);
    check("counts the templates", /templates\s+3/.test(out), out.match(/templates.*/)?.[0]);
    check("counts the ones carrying a script", /carrying <script>\s+1/.test(out));
    check("names the at-risk template", out.includes("Stats Counter"));
    check("warns that a published site is affected", /INCLUDING A PUBLISHED, LIVE SITE/.test(out));
    check("does not flag the plain template", !/Hero Plain/.test(out.split("go blank")[1] ?? ""));
    check("says nothing was deleted", /nothing was deleted/i.test(out));

    const afterReport = await snapshot(uri);
    check("deleted no templates", afterReport.templates === 3, `${afterReport.templates}`);
    check("touched no colleges", afterReport.colleges === 2);
    check("left the seed marker alone", afterReport.marker === 0);

    /* ── Delete mode ────────────────────────────────────────────────────── */
    console.log("\n\x1b[1mDelete mode (--yes)\x1b[0m");
    const del = run(uri, ["--yes"]);
    check("exits cleanly", del.status === 0, `status ${del.status} ${del.stderr?.slice(0, 160)}`);

    const after = await snapshot(uri);
    check("every template is gone", after.templates === 0, `${after.templates} left`);
    check("colleges survive", after.colleges === 2, `${after.colleges}`);
    check("access requests survive", after.requests === 1);
    check("the admin account survives", after.admins === 1);
    check("the re-seed marker is set, so a restart will not refill", after.marker === 1);

    /* ── The part that matters most: tenant content is untouched ────────── */
    console.log("\n\x1b[1mTenant content\x1b[0m");
    const tc = after.testCollege;
    check("the draft still has both sections", tc.websiteConfig.pages[0].sections.length === 2);
    check("section markup is byte-identical", tc.websiteConfig.pages[0].sections[0].code === PLAIN_CODE);
    check("the published site still has its section", tc.publishedConfig.pages[0].sections.length === 1);
    check("publishedVersion is unchanged", tc.publishedVersion === 3, `${tc.publishedVersion}`);
    check("the tenant's user account is intact", tc.users.length === 1 && Boolean(tc.users[0].passwordHash));
    check("section templateId is left as provenance", Boolean(tc.websiteConfig.pages[0].sections[0].templateId));
    check("the college's dangling templateId is cleared", tc.templateId === null, `${tc.templateId}`);

    /* ── Idempotent ─────────────────────────────────────────────────────── */
    console.log("\n\x1b[1mRun again\x1b[0m");
    const again = run(uri, ["--yes"]);
    check("a second run is a no-op, not an error", again.status === 0);
    check("  …and says so", /already empty/i.test(again.stdout || ""));
  } finally {
    await mongo.stop().catch(() => null);
  }

  console.log(`\n${"─".repeat(56)}`);
  if (failures.length === 0) {
    console.log(green(`${passed} passed, 0 failed`));
  } else {
    console.log(red(`${passed} passed, ${failures.length} failed`));
    for (const f of failures) console.log(`  ${red("✗")} ${f}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(red("\nharness failed:"), error);
  process.exit(2);
});
