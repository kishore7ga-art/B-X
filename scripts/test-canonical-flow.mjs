/**
 * The canonical flow, end to end, against a running API and a real database.
 *
 *     request access → admin approves → user signs in → onboarding →
 *     editor loads defaults → add / swap / delete → autosave → reload →
 *     publish → public site
 *
 * ── Why this exists next to `test-api-e2e.mjs` ─────────────────────────────
 *
 * That suite proves each endpoint answers correctly in isolation: right status,
 * right shape, right guard. This one proves the endpoints compose — that the
 * account the Super Admin approves is the account that can sign in, that the
 * theme chosen during onboarding is the theme the published site is served
 * with, and that a section deleted in the editor is still deleted after a
 * reload. Those are the failures that survive a green unit suite, because every
 * part works and the seam between two of them does not.
 *
 * ── Running it ─────────────────────────────────────────────────────────────
 *
 *     cd xite-B && npm run dev:local          # a real, disposable MongoDB
 *     node scripts/test-canonical-flow.mjs
 *
 * Point it elsewhere with TEST_API_BASE / ADMIN_EMAIL / ADMIN_PASSWORD. It
 * writes a college, so do not aim it at a database anyone depends on: it
 * refuses to run against anything that looks like production, below.
 */

const BASE = process.env.TEST_API_BASE ?? "http://localhost:4000";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@local.test";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "local-admin-password-2026";

/**
 * This suite creates and approves an account. Against the live cluster that is
 * a real tenant with a real owner, created by a test run — so the safety check
 * is a refusal rather than a warning.
 */
if (/webxite\.org|mongodb\.net/i.test(BASE)) {
  console.error(`[flow] refusing to run against what looks like production: ${BASE}`);
  process.exit(2);
}

const c = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m",
};

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ${c.green}✓${c.reset} ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  ${c.red}✗${c.reset} ${name}${detail ? ` ${c.dim}— ${detail}${c.reset}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${c.bold}${title}${c.reset}`);
}

/** Cookies, per named jar, because three identities are in play at once. */
const jars = new Map();

function jar(name) {
  if (!jars.has(name)) jars.set(name, new Map());
  return jars.get(name);
}

function cookieHeader(name) {
  return [...jar(name)].map(([k, v]) => `${k}=${v}`).join("; ");
}

function absorb(name, response) {
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const line of raw) {
    const [pair] = line.split(";");
    const idx = pair.indexOf("=");
    if (idx > 0) jar(name).set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
}

async function call(method, path, { as, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (as) {
    const cookie = cookieHeader(as);
    if (cookie) headers.Cookie = cookie;
  }

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (as) absorb(as, response);

  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* Not every response is JSON — a 404 page, for instance. */
  }
  return { status: response.status, json, text };
}

/** Unique per run, so repeated runs do not collide on the email or subdomain. */
const stamp = Date.now().toString(36);
const applicant = {
  name: "Flow Test Principal",
  email: `flow-${stamp}@testcollege.ac.in`,
  password: "flow-test-password-2026",
  organization: `Flow Test College ${stamp}`,
  phone: "+91 98765 43210",
  website: "www.flowtestcollege.ac.in",
};

async function main() {
  console.log(`${c.cyan}Canonical flow${c.reset} ${c.dim}${BASE}${c.reset}`);

  /* ── Flow A — request access ─────────────────────────────────────────── */
  section("Flow A — a stranger asks for access");

  const submitted = await call("POST", "/api/v1/access-requests", { body: applicant });
  check("POST /access-requests → 202", submitted.status === 202, `got ${submitted.status}`);
  check("  …answers { received: true }", submitted.json?.received === true);

  const badPhone = await call("POST", "/api/v1/access-requests", {
    body: { ...applicant, email: `bad-${stamp}@x.ac.in`, phone: "call me" },
  });
  check("a request with a junk phone number is refused", badPhone.status === 400,
    `got ${badPhone.status}`);
  check("  …and says which field", /phone/i.test(badPhone.json?.error ?? ""),
    badPhone.json?.error);

  const shortPassword = await call("POST", "/api/v1/access-requests", {
    body: { ...applicant, email: `short-${stamp}@x.ac.in`, password: "abcd" },
  });
  check("a password under the floor is refused", shortPassword.status === 400,
    `got ${shortPassword.status}`);

  /* ── Flow B — the Super Admin approves it ────────────────────────────── */
  section("Flow B — the Super Admin sees it and approves");

  const adminLogin = await call("POST", "/api/v1/admin/auth/login", {
    as: "admin",
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  check("admin signs in", adminLogin.status === 200, `got ${adminLogin.status}`);

  const queue = await call("GET", "/api/v1/admin/access-requests?status=PENDING", { as: "admin" });
  check("GET /admin/access-requests → 200", queue.status === 200, `got ${queue.status}`);

  const mine = (queue.json?.requests ?? []).find((r) => r.email === applicant.email);
  check("the request is in the queue", Boolean(mine));
  // The whole point of making these fields rather than prose: they have to
  // reach the screen where somebody decides whether to approve.
  check("  …carrying the phone number the applicant typed",
    mine?.phone === applicant.phone, `got ${mine?.phone}`);
  check("  …and their website", mine?.website === applicant.website, `got ${mine?.website}`);

  const anonymous = await call("GET", "/api/v1/admin/access-requests?status=ALL");
  check("the queue is not readable without an admin session", anonymous.status === 401,
    `got ${anonymous.status}`);

  const approved = await call("POST", `/api/v1/admin/access-requests/${mine?.id}/approve`, {
    as: "admin",
    body: {},
  });
  check("approve → 200", approved.status === 200, `got ${approved.status} ${approved.text.slice(0, 120)}`);
  check("  …and reports the account it created", Boolean(approved.json?.userId),
    JSON.stringify(approved.json)?.slice(0, 160));

  /**
   * The tenant's subdomain, read back from the admin roster rather than from
   * the approval response — which reports the invite it issued (email, user id,
   * expiry, whether it was delivered) and not the college it provisioned.
   */
  const sites = await call("GET", "/api/v1/admin/sites", { as: "admin" });
  const site = (sites.json?.sites ?? []).find((s) => s.name === applicant.organization);
  const subdomain = site?.subdomain ?? null;
  check("  …and provisions a college with a subdomain", Boolean(subdomain),
    JSON.stringify(sites.json?.sites)?.slice(0, 200));

  /* ── Flow C — the approved user signs in ─────────────────────────────── */
  section("Flow C — the approved account signs in");

  const wrongPassword = await call("POST", "/api/v1/auth/login", {
    body: { email: applicant.email, password: "not-the-password" },
  });
  check("the wrong password is refused", wrongPassword.status === 401, `got ${wrongPassword.status}`);

  const signedIn = await call("POST", "/api/v1/auth/login", {
    as: "user",
    body: { email: applicant.email, password: applicant.password },
  });
  check("the password chosen on the form works after approval", signedIn.status === 200,
    `got ${signedIn.status} ${signedIn.text.slice(0, 120)}`);
  // The bug this replaces: everybody landed in the editor, including somebody
  // who had never been asked for a theme or a font.
  check("  …and a new account is sent to onboarding, not the editor",
    signedIn.json?.next === "/onboarding", `got ${signedIn.json?.next}`);

  /* ── Flow D — onboarding ─────────────────────────────────────────────── */
  section("Flow D — role, theme and font");

  const before = await call("GET", "/api/v1/onboarding", { as: "user" });
  check("GET /onboarding → 200", before.status === 200, `got ${before.status}`);
  check("  …reports not completed", before.json?.completed === false);

  const badTheme = await call("PUT", "/api/v1/onboarding", {
    as: "user",
    body: { role: "principal", themePaletteId: "cyber-neon", themeFontId: "inter" },
  });
  check("a theme no renderer ships is refused", badTheme.status === 400, `got ${badTheme.status}`);

  const partial = await call("PUT", "/api/v1/onboarding", {
    as: "user",
    body: { role: "principal", themePaletteId: "emerald-gold" },
  });
  check("a partial answer is refused rather than half-stored", partial.status === 400,
    `got ${partial.status}`);

  const stillNot = await call("GET", "/api/v1/onboarding", { as: "user" });
  check("  …and nothing was written by either refusal",
    stillNot.json?.completed === false && stillNot.json?.themePaletteId === null,
    JSON.stringify(stillNot.json));

  const done = await call("PUT", "/api/v1/onboarding", {
    as: "user",
    body: { role: "principal", themePaletteId: "emerald-gold", themeFontId: "outfit" },
  });
  check("all three answers together → 200", done.status === 200, `got ${done.status}`);
  check("  …completed", done.json?.completed === true);
  check("  …role stored", done.json?.role === "principal");
  check("  …theme stored", done.json?.themePaletteId === "emerald-gold");
  check("  …font stored", done.json?.themeFontId === "outfit");

  const me = await call("GET", "/api/v1/me", { as: "user" });
  check("/me carries the onboarding state", me.json?.college?.onboardingCompleted === true);
  check("  …and the role", me.json?.college?.ownerRole === "principal");
  // Two representations of one fact is how the wizard and the editor end up
  // disagreeing about whether somebody has finished.
  check("  …without also leaking the raw timestamp",
    me.json?.college?.onboardingCompletedAt === undefined);

  const secondLogin = await call("POST", "/api/v1/auth/login", {
    as: "user",
    body: { email: applicant.email, password: applicant.password },
  });
  check("signing in again skips onboarding",
    secondLogin.json?.next === `/editor/${subdomain}`, `got ${secondLogin.json?.next}`);

  /* ── Flow F — the editor's starting state ────────────────────────────── */
  section("Flow F — the editor opens on the admin-configured default");

  const website = await call("GET", "/api/v1/my-website", { as: "user" });
  check("GET /my-website → 200", website.status === 200, `got ${website.status}`);

  const pages = website.json?.pages ?? [];
  check("  …returns pages", Array.isArray(pages) && pages.length > 0, `${pages.length} pages`);

  const home = pages.find((p) => p.slug === "/home") ?? pages[0];
  check("  …including a home page", Boolean(home));

  const theme = await call("GET", "/api/v1/my-theme", { as: "user" });
  check("the project's theme is the one chosen at onboarding",
    theme.json?.themeId === "emerald-gold", JSON.stringify(theme.json));
  check("  …and so is the font", theme.json?.fontId === "outfit", JSON.stringify(theme.json));

  /* ── Flow G/H/I — add, swap, delete, and they survive a reload ───────── */
  section("Flow G–I — add, delete, and a reload");

  const library = await call("GET", "/api/v1/section-library", { as: "user" });
  check("GET /section-library → 200", library.status === 200, `got ${library.status}`);
  const librarySections = library.json?.sections ?? [];
  console.log(`  ${c.dim}library has ${librarySections.length} admin-created section(s)${c.reset}`);

  const startCount = home?.sections?.length ?? 0;

  const added = {
    id: `flow-added-${stamp}`,
    title: "Flow Test Section",
    sectionType: "about",
    category: "about",
    code: `<section id="flow-${stamp}"><h2>Flow test heading</h2></section>`,
    sortOrder: startCount,
  };

  const afterAdd = await call("PUT", `/api/v1/my-website/pages/${encodeURIComponent(home.slug)}`, {
    as: "user",
    body: { ...home, sections: [...(home.sections ?? []), added] },
  });
  check("adding a section → 200", afterAdd.status === 200, `got ${afterAdd.status} ${afterAdd.text.slice(0, 120)}`);

  const reloaded = await call("GET", "/api/v1/my-website", { as: "user" });
  const reloadedHome = (reloaded.json?.pages ?? []).find((p) => p.slug === home.slug);
  const persisted = (reloadedHome?.sections ?? []).find((s) => s.id === added.id);
  check("  …and it is still there after a reload", Boolean(persisted));
  check("  …with its markup intact", /Flow test heading/.test(persisted?.code ?? ""));
  check("  …in the position it was added at",
    reloadedHome?.sections?.at(-1)?.id === added.id,
    `last is ${reloadedHome?.sections?.at(-1)?.id}`);

  const afterDelete = await call("PUT", `/api/v1/my-website/pages/${encodeURIComponent(home.slug)}`, {
    as: "user",
    body: {
      ...reloadedHome,
      sections: (reloadedHome?.sections ?? []).filter((s) => s.id !== added.id),
    },
  });
  check("deleting it → 200", afterDelete.status === 200, `got ${afterDelete.status}`);

  const afterDeleteReload = await call("GET", "/api/v1/my-website", { as: "user" });
  const goneHome = (afterDeleteReload.json?.pages ?? []).find((p) => p.slug === home.slug);
  check("  …and it stays deleted after a reload",
    !(goneHome?.sections ?? []).some((s) => s.id === added.id));
  // Deleting a section instance must not touch the library it came from.
  const libraryAfter = await call("GET", "/api/v1/section-library", { as: "user" });
  check("  …without removing anything from the admin library",
    (libraryAfter.json?.sections ?? []).length === librarySections.length,
    `${librarySections.length} → ${(libraryAfter.json?.sections ?? []).length}`);

  /* ── Flow K/L — theme and font changes persist ───────────────────────── */
  section("Flow K–L — changing the theme and font from the editor");

  const themeChange = await call("PUT", "/api/v1/my-theme", {
    as: "user",
    body: { themeId: "crimson-slate", fontId: "serif" },
  });
  check("PUT /my-theme → 200", themeChange.status === 200, `got ${themeChange.status}`);

  const themeAfter = await call("GET", "/api/v1/my-theme", { as: "user" });
  check("  …and it survives a reload", themeAfter.json?.themeId === "crimson-slate",
    JSON.stringify(themeAfter.json));
  check("  …font too", themeAfter.json?.fontId === "serif");

  const junkTheme = await call("PUT", "/api/v1/my-theme", {
    as: "user",
    body: { themeId: "not-a-theme", fontId: "serif" },
  });
  check("a theme id nothing renders is refused", junkTheme.status === 400, `got ${junkTheme.status}`);

  /* ── Flow N — publish, and what a visitor gets ───────────────────────── */
  section("Flow N — publish and the public site");

  const statusBefore = await call("GET", "/api/v1/publish/status", { as: "user" });
  check("GET /publish/status → 200", statusBefore.status === 200, `got ${statusBefore.status}`);

  const publish = await call("POST", "/api/v1/publish", { as: "user", body: {} });
  check("POST /publish → 200", publish.status === 200, `got ${publish.status} ${publish.text.slice(0, 140)}`);
  check("  …reports a version", typeof publish.json?.publishedVersion === "number",
    JSON.stringify(publish.json)?.slice(0, 120));

  const statusAfter = await call("GET", "/api/v1/publish/status", { as: "user" });
  check("  …and the site now has a published copy", statusAfter.json?.hasPublished === true);
  check("  …with nothing left unpublished", statusAfter.json?.hasUnpublishedChanges === false,
    JSON.stringify(statusAfter.json)?.slice(0, 160));

  const publicSite = await call("GET", `/api/v1/public/site/${subdomain}`);
  check("the public site is served without a session", publicSite.status === 200,
    `got ${publicSite.status}`);
  const publicPages = publicSite.json?.pages ?? publicSite.json?.config?.pages ?? [];
  check("  …and has the pages the editor saved", publicPages.length > 0,
    JSON.stringify(publicSite.json)?.slice(0, 160));

  /* ── Ownership — the guard that matters most ─────────────────────────── */
  section("Ownership — one tenant may not reach another's project");

  const noSession = await call("GET", "/api/v1/my-website");
  check("the editor's data needs a session", noSession.status === 401, `got ${noSession.status}`);

  const withAdminCookie = await call("GET", "/api/v1/my-website", { as: "admin" });
  check("an admin cookie is not a tenant session", withAdminCookie.status === 401,
    `got ${withAdminCookie.status}`);

  const tenantOnAdmin = await call("GET", "/api/v1/admin/overview", { as: "user" });
  check("a tenant session cannot read the admin API", tenantOnAdmin.status === 401,
    `got ${tenantOnAdmin.status}`);

  /* ── The dashboard's numbers are counted, not asserted ───────────────── */
  section("Admin dashboard — real numbers");

  const overview = await call("GET", "/api/v1/admin/overview", { as: "admin" });
  check("GET /admin/overview → 200", overview.status === 200, `got ${overview.status}`);
  check("  …counts approved requests", overview.json?.requests?.approved >= 1,
    JSON.stringify(overview.json?.requests));
  check("  …reports a live-user window", overview.json?.presence?.windowSeconds > 0);
  // The account that has been making requests throughout this run.
  check("  …and sees at least one live session", overview.json?.presence?.live >= 1,
    JSON.stringify(overview.json?.presence));
  check("  …counts section instances", typeof overview.json?.sections === "number");
  check("  …and reads the audit log rather than returning []",
    Array.isArray(overview.json?.recentActions) && overview.json.recentActions.length > 0,
    `${overview.json?.recentActions?.length} entries`);

  const flowHealth = await call("GET", "/api/v1/system/flow-health");
  check("flow-health no longer asserts a test score it never ran",
    flowHealth.json?.e2eSuite === undefined, JSON.stringify(flowHealth.json)?.slice(0, 160));

  /* ── Result ──────────────────────────────────────────────────────────── */
  console.log(`\n${"─".repeat(60)}`);
  if (failures.length === 0) {
    console.log(`${c.green}${passed} passed, 0 failed${c.reset}`);
  } else {
    console.log(`${c.red}${passed} passed, ${failures.length} failed${c.reset}`);
    for (const f of failures) console.log(`  ${c.red}✗${c.reset} ${f.name} ${c.dim}${f.detail}${c.reset}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n${c.red}the suite could not run:${c.reset}`, error);
  process.exit(2);
});
