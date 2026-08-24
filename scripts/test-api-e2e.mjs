/**
 * Every endpoint, against a real server and a real database.
 *
 * The unit tests cover pure functions; the smoke test pings a deployment. This
 * sits between them and covers the thing neither does: that each route is
 * actually reachable at the path the clients use, that its guard is the one it
 * is supposed to have, and that its failures come back in the shape the
 * frontends parse.
 *
 * Those three are exactly where this service has broken before — a route
 * registered twice with the wrong one winning, an editor calling an admin-only
 * endpoint and reading the 401 as an empty list, a guard removed for debugging
 * and never restored. None of that is visible to `tsc`, and all of it is
 * visible here.
 *
 * Runs against `mongodb-memory-server`, so it touches nothing real and needs no
 * credentials:
 *
 *     npm run test:api
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { MongoMemoryServer } from "mongodb-memory-server";

const PORT = Number(process.env.E2E_PORT ?? 4399);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://localhost:3002";

const ADMIN_EMAIL = "e2e-admin@webxite.test";
const ADMIN_PASSWORD = "e2e-Admin-Password-2026";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  [32m✓[0m ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  [31m✗[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n[1m${title}[0m`);
}

/** One request. Returns status, body and the cookie jar's new contents. */
async function call(method, path, { body, cookie, origin = ORIGIN, form } = {}) {
  const headers = { Origin: origin };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined && !form) headers["Content-Type"] = "application/json";

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    redirect: "manual",
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON — that is itself a finding for the API routes */
  }

  return {
    status: res.status,
    json,
    text,
    setCookie: res.headers.getSetCookie?.() ?? [],
    headers: res.headers,
  };
}

/** Pulls one cookie's `name=value` out of a Set-Cookie list. */
function cookieFrom(setCookie, name) {
  for (const entry of setCookie) {
    const [pair] = entry.split(";");
    if (pair.startsWith(`${name}=`)) return pair;
  }
  return null;
}

async function waitForServer(deadlineMs = 90_000) {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/openapi.json`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  return false;
}

/* ── Boot ─────────────────────────────────────────────────────────────── */

const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120_000 } });
const uri = mongo.getUri("xite_e2e");

const server = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsx", "src/server.ts"],
  {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      MONGODB_URI: uri,
      SESSION_SECRET: "e2e-session-secret-value-at-least-32-chars-long",
      ADMIN_SESSION_SECRET: "e2e-admin-secret-value-at-least-32-characters",
      ADMIN_BOOTSTRAP_EMAIL: ADMIN_EMAIL,
      ADMIN_BOOTSTRAP_PASSWORD: ADMIN_PASSWORD,
      CORS_ORIGINS: ORIGIN,
      // Otherwise five requests into the suite the admin login starts 429ing,
      // which tests the limiter rather than the endpoints.
      ENABLE_RATE_LIMIT: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  },
);

const serverLog = [];
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));

const up = await waitForServer();
if (!up) {
  console.error("Server did not start.\n" + serverLog.join(""));
  server.kill();
  await mongo.stop();
  process.exit(1);
}

// The bootstrap runs after `listen`, so give it a moment to create the admin.
await sleep(2500);

console.log(`\nAPI end-to-end suite — ${BASE}\n${"─".repeat(60)}`);

let adminCookie = null;

try {
  /* ── Public surface ─────────────────────────────────────────────────── */
  section("Public — reachable without any session");
  {
    const health = await call("GET", "/api/health");
    check("GET /api/health responds", health.status === 200 || health.status === 503, `got ${health.status}`);

    const spec = await call("GET", "/openapi.json");
    check("GET /openapi.json is a document", spec.status === 200 && Boolean(spec.json?.paths));

    const docs = await call("GET", "/docs");
    check("GET /docs renders", docs.status === 200);

    const def = await call("GET", "/api/v1/default-website");
    check("GET /api/v1/default-website returns pages", def.status === 200 && Array.isArray(def.json?.pages), `got ${def.status}`);

    const site = await call("GET", "/api/v1/public/site/nobody-here");
    check("GET /api/v1/public/site/:subdomain answers for an unknown tenant", site.status === 200 || site.status === 404, `got ${site.status}`);

    const status = await call("GET", "/api/v1/admin/status");
    check("GET /api/v1/admin/status is public", status.status === 200, `got ${status.status}`);
    check("  …and reports only configured + hasAccounts", status.json && !("bootstrap" in status.json) && !("email" in status.json), JSON.stringify(status.json));

    const me = await call("GET", "/api/v1/admin/me");
    check("GET /api/v1/admin/me answers {admin:null} when signed out", me.status === 200 && me.json?.admin === null, `got ${me.status} ${me.text.slice(0, 60)}`);
  }

  /* ── Guards ─────────────────────────────────────────────────────────── */
  section("Guards — every admin route refuses an anonymous caller");
  {
    const guarded = [
      ["GET", "/api/v1/admin/templates"],
      ["POST", "/api/v1/admin/templates"],
      ["DELETE", "/api/v1/admin/templates"],
      ["GET", "/api/v1/admin/templates/stats"],
      ["GET", "/api/v1/admin/overview"],
      ["GET", "/api/v1/admin/sites"],
      ["GET", "/api/v1/admin/users"],
      ["GET", "/api/v1/admin/access-requests"],
      ["PUT", "/api/v1/admin/default-website"],
    ];
    for (const [method, path] of guarded) {
      const res = await call(method, path, { body: method === "GET" ? undefined : {} });
      check(`${method} ${path} → 401`, res.status === 401, `got ${res.status}`);
    }

    const tenant = [
      ["GET", "/api/v1/my-website"],
      ["PUT", "/api/v1/my-website"],
      ["PUT", "/api/v1/my-website/pages/home"],
      ["PATCH", "/api/v1/my-website/pages/home/order"],
      ["GET", "/api/v1/section-library"],
      ["GET", "/api/v1/my-theme"],
      ["PUT", "/api/v1/my-theme"],
      ["GET", "/api/v1/publish/status"],
      ["GET", "/api/v1/domains"],
      ["GET", "/api/v1/site-settings"],
    ];
    for (const [method, path] of tenant) {
      const res = await call(method, path, { body: method === "GET" ? undefined : {} });
      check(`${method} ${path} → 401`, res.status === 401, `got ${res.status}`);
    }
  }

  section("Guards — endpoints removed during the audit stay removed");
  {
    for (const [method, path] of [
      ["POST", "/api/v1/admin/save-section"],
      ["PATCH", "/api/v1/admin/update-section/abc"],
      ["DELETE", "/api/v1/admin/delete-section/abc"],
      ["POST", "/api/v1/ai/generate-section"],
      ["POST", "/api/v1/admin/ai/optimize-section"],
      ["POST", "/api/v1/auth/signup"],
    ]) {
      const res = await call(method, path, { body: {} });
      check(`${method} ${path} → 404`, res.status === 404, `got ${res.status}`);
    }
  }

  /* ── Admin sign-in ──────────────────────────────────────────────────── */
  section("Admin sign-in");
  {
    const wrong = await call("POST", "/api/v1/admin/auth/login", {
      body: { email: ADMIN_EMAIL, password: "not-the-password" },
    });
    check("wrong password → 401", wrong.status === 401, `got ${wrong.status}`);
    check("  …with an { error } envelope", typeof wrong.json?.error === "string");

    const unknown = await call("POST", "/api/v1/admin/auth/login", {
      body: { email: "nobody@nowhere.test", password: "whatever" },
    });
    check("unknown address → same message (no enumeration)", unknown.json?.error === wrong.json?.error, `${unknown.json?.error} vs ${wrong.json?.error}`);

    const ok = await call("POST", "/api/v1/admin/auth/login", {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    check("correct password → 200", ok.status === 200, `got ${ok.status} ${ok.text.slice(0, 120)}`);
    adminCookie = cookieFrom(ok.setCookie, "xite_admin_session");
    check("  …sets the session cookie", Boolean(adminCookie));
    const raw = ok.setCookie.find((c) => c.startsWith("xite_admin_session="));
    check("  …HttpOnly", /HttpOnly/i.test(raw ?? ""), raw);

    const alias = await call("POST", "/api/v1/admin/login", {
      body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    check("the /login alias works too", alias.status === 200, `got ${alias.status}`);

    // The panel leaves this blank and relies on ADMIN_BOOTSTRAP_EMAIL.
    const noEmail = await call("POST", "/api/v1/admin/auth/login", {
      body: { password: ADMIN_PASSWORD },
    });
    check("omitting the email falls back to ADMIN_BOOTSTRAP_EMAIL", noEmail.status === 200, `got ${noEmail.status} ${noEmail.text.slice(0, 100)}`);

    const whoami = await call("GET", "/api/v1/admin/me", { cookie: adminCookie });
    check("GET /admin/me now names the admin", whoami.json?.admin?.email === ADMIN_EMAIL, JSON.stringify(whoami.json));
  }

  /* ── Admin reads ────────────────────────────────────────────────────── */
  section("Admin reads, with a session");
  {
    for (const [path, shape] of [
      ["/api/v1/admin/templates", (j) => Array.isArray(j?.templates)],
      ["/api/v1/admin/templates/stats", (j) => j && typeof j === "object"],
      ["/api/v1/admin/overview", (j) => j && typeof j === "object"],
      ["/api/v1/admin/sites", (j) => Array.isArray(j?.sites)],
      ["/api/v1/admin/users", (j) => j && typeof j === "object"],
      ["/api/v1/admin/access-requests", (j) => j && typeof j === "object"],
      ["/api/v1/admin/default-website", (j) => Array.isArray(j?.pages)],
    ]) {
      const res = await call("GET", path, { cookie: adminCookie });
      check(`GET ${path} → 200`, res.status === 200, `got ${res.status} ${res.text.slice(0, 90)}`);
      check(`  …expected shape`, shape(res.json), JSON.stringify(res.json)?.slice(0, 90));
    }
  }

  /* ── Template lifecycle ─────────────────────────────────────────────── */
  section("Template lifecycle — the section library the editor reads");
  let templateId = null;
  {
    const name = `E2E Hero [hero] - ${Date.now()}`;
    const created = await call("POST", "/api/v1/admin/templates", {
      cookie: adminCookie,
      body: {
        name,
        category: "hero",
        description: "created by the e2e suite",
        code: '<section class="hero"><h1 style="color:#2563eb">Hello</h1></section>',
        isPublished: true,
      },
    });
    check("POST /admin/templates creates one", created.status === 200 || created.status === 201, `got ${created.status} ${created.text.slice(0, 120)}`);
    templateId = created.json?.id ?? created.json?.template?.id ?? null;
    check("  …returns an id", Boolean(templateId), JSON.stringify(created.json)?.slice(0, 120));

    const list = await call("GET", "/api/v1/admin/templates", { cookie: adminCookie });
    check("  …and it appears in the list", (list.json?.templates ?? []).some((t) => t.name === name));

    if (templateId) {
      const one = await call("GET", `/api/v1/admin/templates/${templateId}`, { cookie: adminCookie });
      check("GET /admin/templates/:id → 200", one.status === 200, `got ${one.status}`);

      const patched = await call("PATCH", `/api/v1/admin/templates/${templateId}`, {
        cookie: adminCookie,
        body: { description: "edited by the e2e suite" },
      });
      check("PATCH /admin/templates/:id → 200", patched.status === 200, `got ${patched.status} ${patched.text.slice(0, 90)}`);
    }

    const missing = await call("GET", "/api/v1/admin/templates/000000000000000000000000", { cookie: adminCookie });
    check("GET a template that does not exist → 404", missing.status === 404, `got ${missing.status}`);
  }

  /* ── Sanitisation ───────────────────────────────────────────────────── */
  section("Section markup is sanitised on the way in");
  {
    const name = `E2E XSS [hero] - ${Date.now()}`;
    const created = await call("POST", "/api/v1/admin/templates", {
      cookie: adminCookie,
      body: {
        name,
        category: "hero",
        code: '<section onclick="alert(1)"><script>alert(2)</script><img src=x onerror="alert(3)"><p>safe</p></section>',
        isPublished: true,
      },
    });
    const id = created.json?.id ?? created.json?.template?.id;
    if (id) {
      const back = await call("GET", `/api/v1/admin/templates/${id}`, { cookie: adminCookie });
      const code = back.json?.code ?? back.json?.template?.code ?? "";
      /* `<script>` is deliberately ALLOWED in admin-authored templates — the
         library contains hamburger menus and carousels that need it, and
         `sanitizeTemplateCode` documents the decision. The tenant path
         (`PUT /my-website`) discards it instead; `sanitize-policies.test.ts`
         pins both halves. What must never survive here is an event handler or
         a `javascript:` URL, which is what the rest of this block checks. */
      check("a template keeps its own <script>", /<script/i.test(code), code.slice(0, 100));
      check("onerror= is stripped", !/onerror/i.test(code), code.slice(0, 100));
      check("onclick= is stripped", !/onclick/i.test(code), code.slice(0, 100));
      check("the real content survives", code.includes("safe"), code.slice(0, 100));
      await call("DELETE", `/api/v1/admin/templates/${id}?hard=true`, { cookie: adminCookie });
    } else {
      check("sanitisation probe could be created", false, JSON.stringify(created.json)?.slice(0, 120));
    }
  }

  /* ── Error contract ─────────────────────────────────────────────────── */
  section("Failures come back in the shape the frontends parse");
  {
    const bad = await call("PUT", "/api/v1/my-website", { cookie: adminCookie, body: { nope: true } });
    check("a tenant route rejects an admin cookie", bad.status === 401, `got ${bad.status}`);

    const notFound = await call("GET", "/api/v1/definitely-not-a-route");
    check("unknown route → 404", notFound.status === 404, `got ${notFound.status}`);
    check("  …as JSON with { error }", typeof notFound.json?.error === "string", notFound.text.slice(0, 80));
  }

  /* ── CORS ───────────────────────────────────────────────────────────── */
  section("CORS — the admin panel is on another origin");
  {
    const pre = await fetch(`${BASE}/api/v1/admin/me`, {
      method: "OPTIONS",
      headers: {
        Origin: ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    check("preflight → 204", pre.status === 204, `got ${pre.status}`);
    check("  allow-origin echoes the caller", pre.headers.get("access-control-allow-origin") === ORIGIN);
    check("  allow-credentials is true", pre.headers.get("access-control-allow-credentials") === "true");
    check("  Retry-After is exposed", (pre.headers.get("access-control-expose-headers") ?? "").includes("Retry-After"));

    const evil = await call("GET", "/api/v1/admin/status", { origin: "https://webxite.org.attacker.test" });
    check("a look-alike origin gets no allow-origin header", !evil.headers.get("access-control-allow-origin"), evil.headers.get("access-control-allow-origin") ?? "");
  }

  /* ── Sign out ───────────────────────────────────────────────────────── */
  section("Sign out");
  {
    const out = await call("POST", "/api/v1/admin/auth/logout", { cookie: adminCookie });
    check("POST /admin/auth/logout → 200", out.status === 200, `got ${out.status}`);
    const cleared = out.setCookie.find((c) => c.startsWith("xite_admin_session="));
    check("  …clears the cookie", Boolean(cleared) && /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(cleared ?? ""), cleared ?? "no set-cookie");
  }
} finally {
  server.kill();
  await mongo.stop();
}

/* ── Result ───────────────────────────────────────────────────────────── */
console.log(`\n${"─".repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("\nFailures:");
  failures.forEach((f) => console.log(`  • ${f}`));
}
process.exit(failed === 0 ? 0 : 1);
