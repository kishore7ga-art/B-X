/**
 * The whole platform, on this machine, with a database that needs no credentials.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * The `.env` in this repo points `MONGODB_URI` at the production Atlas cluster,
 * and that credential no longer authenticates — every script here fails with
 * `bad auth : authentication failed`. So there was no way to run the backend
 * locally at all, which also means no way to reproduce anything a tenant
 * reports without pushing to production and looking.
 *
 * This starts `mongodb-memory-server` — a real MongoDB, downloaded once and run
 * from a temporary directory — and points the API at it. No credentials, no
 * network, and nothing it does can reach real data. That last part is the
 * reason to prefer it over fixing the credential even once you have a working
 * one: local development should not be one typo away from writing to the
 * cluster that serves tenants.
 *
 * The data lives as long as the process does. Stop it and the next run starts
 * from an empty database with a fresh admin.
 *
 *     npm run dev:local            # API only, on :4000
 *     npm run dev:local -- --seed  # …and a college with pages to open in the editor
 *
 * Then, in the other two repos:
 *
 *     cd ../xite-F     && npm run dev     # :3000
 *     cd ../xite-admin && npm run dev     # :3002
 *
 * Both already default to `http://localhost:4000`, so nothing needs configuring.
 */
import { spawn } from "node:child_process";
import { MongoMemoryServer } from "mongodb-memory-server";

const PORT = Number(process.env.PORT ?? 4000);
const WANT_SEED = process.argv.includes("--seed");

/**
 * Development credentials, and deliberately obvious ones.
 *
 * They are printed to the console on every start, they only ever exist in a
 * database that vanishes when this process does, and nothing outside this
 * machine can reach the server. Anything that looks like a real secret would
 * be worse: it invites being copied somewhere it matters.
 */
const ADMIN_EMAIL = "admin@local.test";
const ADMIN_PASSWORD = "local-admin-password-2026";
const TENANT_EMAIL = "principal@local.test";
const TENANT_PASSWORD = "local-tenant-password-2026";
const TENANT_SUBDOMAIN = "localcollege";

const CORS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3002",
].join(",");

const bold = (s) => `[1m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;
const green = (s) => `[32m${s}[0m`;

console.log(dim("[dev] starting an in-memory MongoDB (first run downloads it — this can take a minute)"));

const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 180_000 } });
const uri = mongo.getUri("xite_local");

console.log(dim(`[dev] mongodb ready at ${uri.replace(/\/\/[^/]+/, "//127.0.0.1:*")}`));

if (WANT_SEED) {
  console.log(dim("[dev] seeding a tenant to open in the editor…"));
  await seed(uri);
}

const server = spawn("npx", ["tsx", "src/server.ts"], {
  stdio: "inherit",
  // Node 20+ refuses to spawn a `.cmd` directly on Windows — `spawn EINVAL` —
  // so the shell resolves `npx` for us. `scripts/start.mjs` does the same.
  shell: true,
  env: {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(PORT),
    MONGODB_URI: uri,
    // Explicitly cleared. Both are read before MONGODB_URI in some paths, and a
    // stale one in `.env` pointing at Atlas is exactly what this script exists
    // to avoid reaching.
    DATABASE_URL: uri,
    SESSION_SECRET: "local-dev-session-secret-at-least-32-characters-long",
    ADMIN_SESSION_SECRET: "local-dev-admin-secret-at-least-32-characters-long",
    ADMIN_BOOTSTRAP_EMAIL: ADMIN_EMAIL,
    ADMIN_BOOTSTRAP_PASSWORD: ADMIN_PASSWORD,
    CORS_ORIGINS: CORS,
    // Host-only cookies. A `Domain=` of `.webxite.org` would simply not be sent
    // to localhost, and every request would arrive unauthenticated.
    SESSION_COOKIE_DOMAIN: "",
    ROOT_DOMAIN: "localhost",
    APP_URL: "http://localhost:3000",
    // Off, so that signing in and out repeatedly while working does not start
    // returning 429 and look like an auth bug.
    ENABLE_RATE_LIMIT: "false",
    // Never on, whatever `.env` says. It mints a session for a real college
    // without a password, and a local habit of that is how it ends up enabled
    // somewhere it matters.
    AUTH_DISABLED: "false",
    SEED_ON_START: "false",
  },
});

const banner = `
${green("  ●")} ${bold("API")}        http://localhost:${PORT}
${dim("             health")}  http://localhost:${PORT}/api/health
${dim("             docs")}    http://localhost:${PORT}/docs

${bold("  Start these in their own terminals:")}
    cd ../xite-F     && npm run dev    ${dim("→ http://localhost:3000")}
    cd ../xite-admin && npm run dev    ${dim("→ http://localhost:3002")}

${bold("  Sign in")}
    Admin panel   ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}${
      WANT_SEED
        ? `
    Tenant        ${TENANT_EMAIL} / ${TENANT_PASSWORD}
    Editor        http://localhost:3000/editor/${TENANT_SUBDOMAIN}
    Live site     http://localhost:3000/site/${TENANT_SUBDOMAIN}`
        : `
    ${dim(`No tenant yet — rerun with --seed, or approve a request in the admin panel.`)}`
    }

${dim("  This database is in memory. Stopping this process discards everything in it.")}
`;

// After the server's own startup logging, so it is the last thing on screen.
setTimeout(() => console.log(banner), 2500);

const shutdown = async (code) => {
  server.kill();
  await mongo.stop().catch(() => null);
  process.exit(code ?? 0);
};

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
server.on("exit", (code) => void shutdown(code ?? 0));

/**
 * One college with one page, so the editor has something to open.
 *
 * Written with the driver rather than through the API because the API is not
 * up yet — and deliberately minimal: a section carrying a `:root` variable and
 * a colour, which is the exact shape that used to render one way in the Admin
 * and another way everywhere else.
 */
async function seed(mongoUri) {
  const { MongoClient } = await import("mongodb");
  const bcrypt = (await import("bcryptjs")).default;

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db("xite_local");

  const header = `<style>
  :root { --brand: #00693e; --brand-font: 'Times New Roman', Georgia, serif; }
  .site-header { background: var(--brand); padding: 25px 40px; display: flex; align-items: center; justify-content: space-between; }
  .site-header .wordmark { font-family: var(--brand-font); font-size: 28px; letter-spacing: 2px; color: #ffffff; text-transform: uppercase; }
  .site-header nav { display: flex; gap: 26px; }
  .site-header nav a { color: #ffffff; text-decoration: none; font-size: 13px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }
</style>
<header class="site-header">
  <span class="wordmark">Local College</span>
  <nav><a href="/about">About</a><a href="/academics">Academics</a><a href="/contact">Contact</a></nav>
</header>`;

  const pages = [
    {
      id: "page-home",
      slug: "/home",
      title: "Home",
      seo: null,
      sections: [
        {
          id: "sec-local-header",
          title: "Navbar / Header",
          sectionType: "navbar",
          templateId: null,
          variantIndex: 0,
          code: header,
          sortOrder: 0,
        },
      ],
    },
    { id: "page-about", slug: "/about", title: "About", seo: null, sections: [] },
  ];

  await db.collection("colleges").insertOne({
    name: "Local College",
    subdomain: TENANT_SUBDOMAIN,
    status: "ACTIVE",
    adoptable: true,
    isDemo: false,
    publishedVersion: 1,
    users: [
      {
        id: "user-local-1",
        email: TENANT_EMAIL,
        passwordHash: await bcrypt.hash(TENANT_PASSWORD, 12),
        status: "ACTIVE",
        createdAt: new Date(),
      },
    ],
    websiteConfig: { pages },
    publishedConfig: { pages },
    publishedAt: new Date(),
    domains: [],
    settings: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  await client.close();
}
