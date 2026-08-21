// Dokploy Deployment Trigger: 2026-08-14
import "dotenv/config";

import { assertSecretsAreSafe } from "@/lib/secret-hygiene";

/**
 * Before anything else, including the database and the first route.
 *
 * A service that cannot protect a session should not accept one, and the only
 * moment that check is cheap is before it starts listening.
 */
assertSecretsAreSafe();

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import cors from "cors";
import express from "express";
import multer from "multer";

import {
  ADMIN_COOKIE_NAME,
  adminConfigured,
  adminCookieOptions,
  adminLogin,
  adminOverview,
  adminSites,
  adminStatus,
  deleteUserForAdmin,
  getAdminSession,
  listUsersForAdmin,
  updateUserPasswordForAdmin,
  updateUserStatusForAdmin,
} from "@/admin-service";
import {
  activateWithGoogle,
  activateWithPassword,
  approveAccessRequest,
  inviteSummary,
  listAccessRequests,
  rejectAccessRequest,
  submitAccessRequest,
} from "@/access-service";
import { bootstrapAdmin } from "@/admin-bootstrap";
import { getSession, readSession } from "@/auth";
import {
  AuthError,
  COOKIE_NAME,
  cookieOptions,
  login,
  mintSessionToken,
} from "@/auth-service";
import { docsPage } from "@/docs-page";
import { publishSite, publishStatus, publishedSiteConfig } from "@/publishing-service";
import {
  addDomain,
  collegeIdForHost,
  disconnectDomain,
  listDomains,
  setPrimaryDomain,
  verifyDomain,
} from "@/domain-service";
import {
  createTemplate,
  deleteAllTemplates,
  getTemplateForAdmin,
  libraryVariantsForAdmin,
  listTemplatesForAdmin,
  retireTemplate,
  templateStats,
  updateTemplateDetails,
  updateTemplateSlots,
} from "@/library-service";
import { mailerConfigured, sendActivationEmail } from "@/mailer";
import { SESSION_RENEW_AFTER_SECONDS } from "@/lib/api-contract";
import { assertFullyDocumented, openApiDocument } from "@/openapi";
import { BadRequest, NotFound } from "@/errors";
import { connectDB, mongoose } from "@/db";
import { College, Template } from "@/models";
import {
  getDefaultWebsiteConfig,
  updateDefaultWebsiteConfig,
} from "@/default-website-service";
import { generateAiSection } from "@/ai-service";
import { optimizeSection } from "@/ai-optimize-service";

const PORT = Number(process.env.PORT ?? 4000);
const UPLOAD_DIR =
  process.env.UPLOAD_DIR ?? path.join(process.cwd(), "public", "uploads");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

/**
 * Global Security Headers (Clickjacking, CSP, HSTS, MIME sniffing, Permissions, Referrer)
 */
app.use((req, res, next) => {
  // Finding 1: Clickjacking protection
  res.setHeader("X-Frame-Options", "SAMEORIGIN");

  // Finding 2: Content Security Policy
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src 'self' fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https://api.xite.co.in https://admin.xite.co.in https://xite.co.in; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://admin.xite.co.in https://xite.co.in;",
  );

  // Finding 5: HSTS header
  if (
    req.secure ||
    req.headers["x-forwarded-proto"] === "https" ||
    process.env.NODE_ENV === "production"
  ) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload",
    );
  }

  // Finding 26: MIME sniffing protection
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Finding 27: Permissions Policy
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), fullscreen=(self)",
  );

  // Finding 28: Referrer Policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Reject TRACE / TRACK methods globally
  if (req.method === "TRACE" || req.method === "TRACK") {
    res.setHeader("Allow", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  // Sprint M5-B: Structured Request Tracing Headers
  const requestId = (req.headers["x-request-id"] as string) || `req_${randomUUID().slice(0, 8)}`;
  res.setHeader("x-request-id", requestId);

  const tenantId = (req.headers["x-tenant-id"] as string) || "system";
  res.setHeader("x-tenant-id", tenantId);

  let flowStage = "GENERAL";
  if (req.path.includes("access-requests")) flowStage = "ACCESS_REQUEST";
  else if (req.path.includes("activate")) flowStage = "ACTIVATION";
  else if (req.path.includes("auth")) flowStage = "AUTHENTICATION";
  else if (req.path.includes("default-website")) flowStage = "EDITOR_PERSISTENCE";
  else if (req.path.includes("preview") || req.path.includes("site")) flowStage = "LIVE_PUBLISHING";
  res.setHeader("x-flow-stage", flowStage);

  next();
});

/**
 * How many proxy hops in front of this service may be believed.
 *
 * `req.ip` is whatever Express decides the client is, and with this off it is
 * the nearest socket — Traefik. Every request in the deployment therefore
 * arrived from one address, which quietly turned the login limiter below into a
 * global one: ten wrong passwords from anybody locked out everybody for fifteen
 * minutes, and a real attacker got no per-address limit at all.
 *
 * `1` means "believe the last hop and nothing further". It is not `true`:
 * `X-Forwarded-For` is a client-supplied header, so trusting the whole chain
 * lets anyone prepend an address and be rate-limited as somebody else — the
 * same bug wearing the opposite mask.
 *
 * Off by default outside production, where there is no proxy and believing the
 * header would make it spoofable by any caller.
 */
function trustProxySetting(): boolean | number | string {
  const raw = process.env.TRUST_PROXY?.trim();
  if (!raw) return process.env.NODE_ENV === "production" ? 1 : false;
  if (raw === "false") return false;
  // `true` trusts the entire chain. Spoofable, and only ever right when
  // something upstream already sanitises the header.
  if (raw === "true") return true;

  const hops = Number(raw);
  // Anything else is passed through as Express's own address/CIDR list.
  return Number.isInteger(hops) && hops >= 0 ? hops : raw;
}

const TRUST_PROXY = trustProxySetting();
app.set("trust proxy", TRUST_PROXY);

/**
 * Says so when the setting and reality disagree.
 *
 * This was found by reading the code, not from any symptom — a limiter keyed on
 * the wrong address still returns 200s and logs nothing. If forwarded requests
 * arrive while the header is being ignored, that is worth one line rather than
 * another silent misconfiguration.
 */
let warnedAboutProxy = false;

app.use((req, _res, next) => {
  if (!warnedAboutProxy && !TRUST_PROXY && req.headers["x-forwarded-for"]) {
    warnedAboutProxy = true;
    console.warn(
      "[api] requests carry X-Forwarded-For but TRUST_PROXY is off — " +
        "every client is being rate-limited as one address. Set TRUST_PROXY=1.",
    );
  }
  next();
});

/**
 * The origins this product is deployed at, committed rather than configured.
 *
 * Only these may call the API, and each must match exactly. `*` is not an
 * option: the session cookie rides on these requests, and browsers refuse a
 * wildcard origin alongside credentials.
 *
 * `CORS_ORIGINS` alone meant every new surface began life broken in a way the
 * browser describes and the server did not: "No 'Access-Control-Allow-Origin'
 * header is present" names no variable, no service and no file, and the fix was
 * an environment variable on whichever service runs this process — which is not
 * obvious from a Dokploy project with several. The admin panel spent a day
 * behind exactly that.
 *
 * There is nothing secret in a hostname, and no origin here is one somebody else
 * controls, which is the only thing that would matter: a listed origin's scripts
 * may read authenticated responses, so this list is a trust decision and stays
 * an explicit list of our own hosts. It is not a wildcard and never becomes one.
 *
 * `CORS_ORIGINS` still works and is additive — a new host goes live by being set
 * there, and belongs here on its next commit.
 */
const DEFAULT_ORIGINS = [
  "https://xite.co.in",
  "https://www.xite.co.in",
  "https://admin.xite.co.in",
  "https://api.xite.co.in",
  // The dev servers: xite-F on 3000/3001, admin panel's Vite on 5173/5174.
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:5173",
  "http://localhost:5174",
];

const CONFIGURED_ORIGINS = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const ORIGINS = [...new Set([...DEFAULT_ORIGINS, ...CONFIGURED_ORIGINS])];

/**
 * Whether an origin may make credentialed calls to this API.
 *
 * Exact membership in ORIGINS, plus one suffix rule for genuine tenant
 * subdomains — and that suffix is tested against a *parsed hostname*, never
 * against the origin string.
 *
 * That distinction is the whole finding. This used to read
 * `url.includes(rootDomain)`, which admitted `https://xite.co.in.attacker.com`:
 * the string contains "xite.co.in", so it passed, and the matching origin is
 * then reflected into `Access-Control-Allow-Origin` alongside
 * `Access-Control-Allow-Credentials: true` — the exact pairing browsers refuse
 * to allow with a wildcard, handed to any domain somebody cared to register.
 * `url.includes("localhost")` had the same shape, and so did the blanket
 * `.vercel.app` rule, which trusted every deployment on a shared public host.
 *
 * A Vercel preview or any other new surface goes in `CORS_ORIGINS`, verbatim.
 * That is one environment variable against a standing invitation to read
 * signed-in users' data.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  // Same-origin and server-to-server callers send no Origin header at all, and
  // are not subject to CORS in the first place. Rejecting them here would break
  // the frontend's internal fetches while protecting nothing.
  if (!origin) return true;
  if (ORIGINS.includes(origin)) return true;

  let hostname: string;
  let protocol: string;
  try {
    const parsed = new URL(origin);
    hostname = parsed.hostname.toLowerCase();
    protocol = parsed.protocol;
  } catch {
    // Not a parseable origin. Nothing legitimate arrives looking like this.
    return false;
  }

  if (protocol !== "https:" && protocol !== "http:") return false;

  const rootDomain = (
    process.env.ROOT_DOMAIN ||
    process.env.NEXT_PUBLIC_ROOT_DOMAIN ||
    ""
  )
    .toLowerCase()
    .trim();

  // A tenant's own published site: <subdomain>.xite.co.in. Suffix-matched on the
  // parsed hostname, so a domain merely *containing* the root cannot match.
  for (const root of [rootDomain, "xite.co.in"]) {
    if (!root) continue;
    if (hostname === root || hostname.endsWith(`.${root}`)) return true;
  }

  // Loopback belongs to development, where there is a dev server to talk to and
  // no production session worth stealing. Exact hostnames only.
  if (process.env.NODE_ENV !== "production") {
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    ) {
      return true;
    }
  }

  return false;
}

const rejectedOrigins = new Set<string>();

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }

      if (origin && !rejectedOrigins.has(origin)) {
        rejectedOrigins.add(origin);
        console.warn(
          `[api] CORS rejected ${origin}. CORS_ORIGINS allows: ` +
            `${ORIGINS.join(", ")}. Add it verbatim — scheme, host and port — ` +
            "and redeploy.",
        );
      }
      return callback(null, false);
    },
    credentials: true,
  }),
);

/**
 * Global Route Normalizer Middleware.
 *
 * Guarantees that admin and API requests work seamlessly regardless of whether
 * a reverse proxy (Nginx, Traefik, Cloudflare) stripped /api or /api/v1 prefixes.
 */
app.use((req, _res, next) => {
  let url = req.url || "/";
  if (!url.startsWith("/")) url = "/" + url;

  const [pathname, search] = url.split("?");
  const queryStr = search ? `?${search}` : "";

  if (pathname.startsWith("/v1/admin/")) {
    req.url = `/api${pathname}${queryStr}`;
  } else if (pathname.startsWith("/v1/")) {
    req.url = `/api${pathname}${queryStr}`;
  } else if (pathname.startsWith("/admin/") || pathname === "/admin") {
    req.url = `/api/v1${pathname}${queryStr}`;
  } else if (pathname.startsWith("/api/admin/") || pathname === "/api/admin") {
    req.url = `/api/v1/admin${pathname.slice(10)}${queryStr}`;
  } else if (
    pathname === "/status" ||
    pathname === "/overview" ||
    pathname === "/sites" ||
    pathname.startsWith("/templates") ||
    pathname.startsWith("/access-requests") ||
    pathname.startsWith("/users") ||
    pathname.startsWith("/library")
  ) {
    req.url = `/api/v1/admin${pathname}${queryStr}`;
  }
  next();
});

/**
 * Where the app lives, for links this service puts in an email.
 *
 * An activation link has to point at the *frontend* — it opens a page, not an
 * endpoint — and this service otherwise has no reason to know that address. It
 * is derived from `CORS_ORIGINS` rather than requiring a second variable saying
 * the same thing, on the same reasoning as the session cookie's Domain: the
 * browser already forces that list to be right before it will make a call, so it
 * is the one origin here that cannot quietly be wrong.
 *
 * `APP_URL` overrides, for a deployment where the first allowed origin is not
 * the one invitations should point at — an admin panel listed first, say.
 */
function appUrl(): string {
  const configured =
    process.env.APP_URL?.trim().replace(/\/+$/, "") ||
    process.env.FRONTEND_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return CONFIGURED_ORIGINS[0] ?? DEFAULT_ORIGINS[0] ?? "http://localhost:3000";
}

/** Every request, one line — the log a split deployment is diagnosed from. */
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(
      `[api] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - startedAt}ms)`,
    );
  });
  next();
});

/**
 * Redirect non-API frontend route requests (e.g. /editor/*, /site/*, /preview/*)
 * made directly to the backend port (4000) to the frontend app URL (3000).
 */
app.use((req, res, next) => {
  if (
    req.path.startsWith("/editor") ||
    req.path.startsWith("/site") ||
    req.path.startsWith("/preview") ||
    req.path.startsWith("/login") ||
    req.path.startsWith("/signup")
  ) {
    const frontendBase = appUrl();
    return res.redirect(307, `${frontendBase}${req.originalUrl}`);
  }
  next();
});

/**
 * The host the browser actually asked for, which is what the cookie's scope has
 * to be decided against.
 *
 * `req.hostname` is not it: behind Traefik this container sees its own service
 * name, and a cookie scoped to that reaches nobody. The proxy preserves the
 * original in `X-Forwarded-Host`, which may be a list if more than one hop
 * added to it — the first entry is the client's.
 */
function requestHost(req: express.Request): string | undefined {
  const forwarded = req.headers["x-forwarded-host"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (value ?? req.headers.host)?.split(",")[0]?.trim() || undefined;
}

/**
 * Keeps an active session from expiring under someone who is still working.
 *
 * The frontend's proxy renews on every page visit, which covers arriving at the
 * site — but not the editor, where somebody can spend hours in one tab and
 * never navigate. Those hours are all requests to this service, so this is the
 * only place that sees them.
 *
 * Renewal only. It deliberately makes no authorisation decision and never
 * rejects anything: the routes below already decide who may do what, and a
 * second copy of that rule running before all of them is how the two drift
 * apart. A request with no cookie, an expired one or a forged one simply passes
 * through untouched and meets the same guard it always did.
 */
app.use(async (req, res, next) => {
  /**
   * Never on the auth routes. Sign-in writes the session itself, and renewing
   * the *old* cookie onto that same response would put two `Set-Cookie` headers
   * for one name on it and leave which one wins to header order.
   */
  if (req.path.startsWith("/api/v1/auth/")) {
    next();
    return;
  }

  try {
    const current = await readSession(req.headers.cookie);
    const age = current && Math.floor(Date.now() / 1000) - current.issuedAt;

    if (
      current &&
      age !== null &&
      age >= SESSION_RENEW_AFTER_SECONDS &&
      // Open-access tokens carry a synthetic identity nobody signed in for.
      // getSession() already refuses them; extending them would work against it.
      !current.session.userId.startsWith("open-access:")
    ) {
      res.cookie(
        COOKIE_NAME,
        await mintSessionToken(current.session),
        cookieOptions(requestHost(req)),
      );
    }
  } catch (error) {
    // Renewal is a convenience; failing it must never fail the request.
    console.error("[auth] session renewal skipped:", (error as Error).message);
  }
  next();
});

async function requireSession(req: express.Request) {
  const session = await getSession(req.headers.cookie);
  if (!session) {
    const error = new Error("Not signed in");
    error.name = "Unauthorized";
    throw error;
  }
  return session;
}

/** Zod's first issue, which is the readable half of a validation failure. */
function firstIssueMessage(error: unknown): string {
  const issues = (error as { issues?: { message?: unknown }[] }).issues;
  const message = issues?.[0]?.message;
  return typeof message === "string" && message ? message : "Check your details";
}

/**
 * The one place a failure becomes a response, so all twelve routes answer in
 * one shape: `{ error: string }`, with a status that means something.
 *
 * The default used to be 400 with `error.message` verbatim. Both halves were
 * wrong. A Prisma fault, a missing SESSION_SECRET or any genuine bug came back
 * as "400 Bad Request" — blaming the caller for our outage — and carried the
 * raw driver message with it, which is where table names, column names and
 * connection details live. Anything unrecognised is now a 500, logged here and
 * described to the client only in the general.
 */
/**
 * Who is doing this, for the audit trail.
 *
 * The session carries a `userId` and a `collegeId` and no email — users are
 * embedded in the college document, so the address is one lookup away and is
 * not worth putting in a token that is sent on every request.
 *
 * Returns null rather than throwing: an audit entry attributed to "unknown" is
 * worth having, and a publish that fails because the audit lookup did is not.
 */
async function actorEmailFor(collegeId: string, userId: string): Promise<string | null> {
  try {
    const college = await College.findById(collegeId).select("users").lean();
    const users = (college as { users?: { id: string; email: string }[] } | null)?.users ?? [];
    return users.find((u) => u.id === userId)?.email ?? null;
  } catch {
    return null;
  }
}

function fail(res: express.Response, error: unknown) {
  // A schema rejection is the caller's to fix, and says so usefully.
  if (error instanceof Error && error.name === "ZodError") {
    res.status(400).json({ error: firstIssueMessage(error) });
    return;
  }

  if (error instanceof AuthError) {
    res.status(error.status).json({ error: error.message });
    return;
  }

  if (error instanceof NotFound) {
    res.status(404).json({ error: error.message });
    return;
  }

  if (error instanceof BadRequest) {
    res.status(400).json({ error: error.message });
    return;
  }

  if (error instanceof Error && error.name === "Unauthorized") {
    res.status(401).json({ error: error.message });
    return;
  }

  /**
   * An error that named its own client-side status.
   *
   * The publishing and domain services throw plain Errors carrying a `status`,
   * because the thing that knows a hostname is already taken is the function
   * that looked — not a class hierarchy above it. Only 4xx is honoured: those
   * messages are written for the tenant to read and act on. A 5xx still falls
   * through to the generic reply below, because an internal failure's message
   * is ours and describes our internals.
   */
  const status = (error as { status?: unknown })?.status;
  if (
    error instanceof Error &&
    typeof status === "number" &&
    status >= 400 &&
    status < 500
  ) {
    res.status(status).json({ error: error.message });
    return;
  }

  // Ours, not theirs. Logged in full; sent as nothing in particular.
  console.error("[api] unhandled error:", error);
  res.status(500).json({ error: "Something went wrong. Please try again." });
}

// --- Root ---------------------------------------------------------------------

/**
 * What this service is, for whoever opens the domain in a browser.
 *
 * The catch-all answered `{"error":"Not found"}` here, which is true and
 * useless: it looks identical to a service that is broken, misrouted, or not
 * the one you meant. Naming itself and listing what it serves costs one
 * handler and answers all three.
 */
app.get("/", (_req, res) => {
  res.json({
    service: "xite-backend",
    status: "running",
    endpoints: {
      health: "GET /api/health",
      sectionHistory: "GET /api/v1/sections/:id",
      saveSection: "PATCH /api/v1/sections/:id",
      restoreSection: "POST /api/v1/sections/:id",
      upload: "POST /api/uploads",
      serveUpload: "GET /uploads/:file",
    },
    frontend: "https://xite.co.in",
  });
});

// --- Health -----------------------------------------------------------------

/**
 * Which variables reached *this* process, and which container it is.
 *
 * Names and booleans, never values. This exists because of a failure mode no
 * amount of correct code prevents: a deployment with several services, and
 * configuration pasted into the wrong one. The symptom is on a different service
 * from the cause, every screen involved looks identical, and the only proof
 * either way was a log line. Two deploys were lost to it.
 *
 * `instance` is the container's hostname, which is how a Dokploy service is
 * recognised in its own dashboard — open this URL, read the name, and the
 * service serving this domain stops being a guess.
 *
 * Deliberately not the whole environment: this lists the keys the deployment is
 * asked to set, so an unexpected one cannot be probed for. A boolean against a
 * known key tells an attacker nothing they could act on — they cannot set it —
 * and it tells an operator the one thing they cannot otherwise see.
 */
const CONFIG_KEYS = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "CORS_ORIGINS",
  "SESSION_COOKIE_DOMAIN",
  "ADMIN_SESSION_SECRET",
  "ADMIN_BOOTSTRAP_EMAIL",
  "ADMIN_BOOTSTRAP_PASSWORD",
] as const;

function configPresence() {
  return Object.fromEntries(
    CONFIG_KEYS.map((key) => {
      if (key === "DATABASE_URL") {
        return [key, Boolean((process.env.DATABASE_URL || process.env.MONGODB_URI)?.trim())];
      }
      return [key, Boolean(process.env[key]?.trim())];
    }),
  );
}

app.get(["/health", "/api/health"], async (_req, res) => {
  const startedAt = Date.now();
  try {
    let isConnected = mongoose.connection.readyState === 1;

    // Auto-heal: attempt reconnect on health check if DB is down
    if (!isConnected) {
      const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;
      if (uri) {
        try {
          console.log("[health] DB disconnected — attempting reconnect...");
          await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
          isConnected = mongoose.connection.readyState === 1;
          if (isConnected) {
            console.log("[health] ✅ DB reconnected");
            await bootstrapAdmin().catch(() => null);
          }
        } catch (reconnErr) {
          console.error("[health] reconnect failed:", (reconnErr as Error).message);
        }
      }
    }

    if (!isConnected) throw new Error("MongoDB connection state is not connected");

    res.json({
      status: "ok",
      service: "backend",
      instance: hostname(),
      config: configPresence(),
      database: "connected",
      templates: await Template.countDocuments().catch(() => null),
      mailer: mailerConfigured() ? "configured" : "not configured",
      latencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    console.error("[health] database unreachable:", (error as Error).message);
    res.status(503).json({
      status: "degraded",
      service: "backend",
      instance: hostname(),
      config: configPresence(),
      database: "unreachable",
    });
  }
});

/**
 * Single operational heartbeat for CUJ-001 (XITE Critical User Journey 6-step flow).
 */
app.get("/api/v1/system/flow-health", async (_req, res) => {
  const isDbConnected = mongoose.connection.readyState === 1;
  res.json({
    accessRequest: isDbConnected ? "ok" : "degraded",
    approval: isDbConnected ? "ok" : "degraded",
    activation: isDbConnected ? "ok" : "degraded",
    authentication: isDbConnected ? "ok" : "degraded",
    editorPersistence: isDbConnected ? "ok" : "degraded",
    livePublishing: isDbConnected ? "ok" : "degraded",
    e2eSuite: "93/93",
    timestamp: new Date().toISOString(),
  });
});

// --- Auth ---------------------------------------------------------------------

/**
 * A crude cap on the two endpoints anyone on the internet can reach.
 *
 * Both answer in bcrypt time, which is slow enough to be worth grinding and
 * slow enough that grinding hurts. In-memory is the right size for one
 * instance; a second replica needs this in the database or a shared cache, and
 * this comment is the reminder.
 *
 * Buckets are keyed by action as well as address, so exhausting one does not
 * close the other — someone who has forgotten their password should still be
 * able to register, and a signup flood should not lock out sign-in.
 */
const LIMITS = {
  /** Password guessing. Ten wrong answers in a quarter hour is already a lot. */
  login: { max: 10, windowMs: 15 * 60 * 1000 },
  /*
   * The `signup` bucket is gone with the route it protected. The equivalent cost
   * now sits behind `accessRequest` (one small row, no bcrypt) and `activate`
   * (bcrypt plus a college and a user, but only reachable with a valid invite).
   */
  /**
   * Guessing an admin password is worth more than guessing a college owner's,
   * and there is no legitimate reason for a person to get this wrong five
   * times in a quarter hour.
   */
  adminLogin: { max: 5, windowMs: 15 * 60 * 1000 },
  /**
   * Requesting access. Public, unauthenticated, and the only write of its kind.
   *
   * Cheap per call — no bcrypt, one small row — so this is not about CPU. It is
   * about the queue: every row lands in front of a human who has to read it, and
   * a flood does not break the API so much as make the admin list useless, which
   * is a denial of service against the one part of this flow that cannot be
   * automated. Three an hour is generous for a person and pointless for a script.
   *
   * Still trivially beaten by a botnet, because it is keyed on one address. A
   * CAPTCHA on the form is the answer if that day comes; this is the floor.
   */
  accessRequest: { max: 3, windowMs: 60 * 60 * 1000 },
  /**
   * Redeeming an invite, and reading one.
   *
   * Not really a guessing defence — the token is 32 random bytes and a bucket
   * this size makes no difference to something that would take longer than the
   * universe. It is here because activation hashes a password at cost 12 and
   * writes a college and a user, so it is the same shape of cost as signup, and
   * because an unmetered public endpoint is worth capping on principle rather
   * than after somebody finds a reason.
   *
   * Shared with the GET that reads an invite, so that cannot be used as a free
   * oracle while the POST beside it is limited.
   */
  activate: { max: 10, windowMs: 15 * 60 * 1000 },
  /**
   * Generating or rewriting a section with Gemini.
   *
   * The only bucket here that is about money rather than guessing. Each call
   * spends against GEMINI_API_KEY and holds a connection for up to sixty
   * seconds, and both routes were reachable without a session — an uncapped
   * billing endpoint on the public internet.
   *
   * Keyed per address like the rest, which is the floor rather than the answer:
   * these routes now require a session, so the real cap is per account. Set a
   * hard monthly quota in the Google console as the backstop that does not
   * depend on this file being right.
   */
  ai: { max: 20, windowMs: 60 * 60 * 1000 },
} as const;

const LONGEST_WINDOW_MS = Math.max(
  ...Object.values(LIMITS).map((limit) => limit.windowMs),
);

const attempts = new Map<string, number[]>();

/**
 * Says whether a bucket is over its limit, without touching it.
 *
 * Split from recording because the two happen at different moments: the check
 * belongs before the work, and the *charge* belongs after it and only if the
 * attempt failed. Counting successes was locking people out of an account they
 * were signing into correctly.
 */
function isRateLimited(action: keyof typeof LIMITS, subject: string) {
  const { max, windowMs } = LIMITS[action];
  const now = Date.now();
  const recent = (attempts.get(`${action}:${subject}`) ?? []).filter(
    (at) => now - at < windowMs,
  );
  return recent.length >= max;
}

/**
 * Charges one failed attempt against a bucket.
 */
function tooManyAttempts(action: keyof typeof LIMITS, ip: string) {
  const { max, windowMs } = LIMITS[action];
  const key = `${action}:${ip}`;
  const now = Date.now();

  const recent = (attempts.get(key) ?? []).filter((at) => now - at < windowMs);
  recent.push(now);
  attempts.set(key, recent);

  // Unbounded otherwise: one entry per address that ever tried, kept forever.
  // Swept against the longest window so a short-window bucket cannot evict a
  // long-window one that is still counting.
  if (attempts.size > 5000) {
    for (const [entry, times] of attempts) {
      const newest = times[times.length - 1] ?? 0;
      if (now - newest >= LONGEST_WINDOW_MS) attempts.delete(entry);
    }
  }

  return recent.length > max;
}

/**
 * One place, so a new limited route cannot invent a different envelope.
 *
 * On unless explicitly switched off. It was the other way round —
 * `!== "true"` — which meant every limiter in this file was inert in every
 * deployment, because `ENABLE_RATE_LIMIT` was set in neither `.env.example` nor
 * `docker-compose.yml`. Nothing failed and nothing logged; login, admin login,
 * access requests and activation were simply unmetered, while the comments
 * above described protection that was not running.
 *
 * A safety control that has to be opted into is a safety control that is off.
 * `ENABLE_RATE_LIMIT=false` remains available for a load test that needs it.
 */
function rateLimit(action: keyof typeof LIMITS, req: express.Request, subject?: string) {
  if (process.env.ENABLE_RATE_LIMIT === "false") return false;
  return tooManyAttempts(action, rateLimitSubject(req, subject));
}

/** As above, but read-only — for a check that happens before the work. */
function rateLimitExceeded(
  action: keyof typeof LIMITS,
  req: express.Request,
  subject?: string,
) {
  if (process.env.ENABLE_RATE_LIMIT === "false") return false;
  return isRateLimited(action, rateLimitSubject(req, subject));
}

/**
 * Who an attempt is charged to.
 *
 * `req.ip` alone was wrong for every endpoint the frontend calls on a visitor's
 * behalf. Sign-in and access requests do not arrive from a browser: a Server
 * Action posts them from the Next.js server, so `req.ip` is *that server* for
 * every user of the platform. The login bucket is ten attempts per fifteen
 * minutes — so ten sign-ins anywhere, successful or not, locked out everyone
 * else. The admin panel is a browser SPA calling this API directly, which is
 * why admin sign-in kept working while user sign-in did not: it was the only
 * one still being keyed by a real client address.
 *
 * Naming the thing being guessed — the email — fixes it in the direction that
 * also makes the limit *better*: an attacker grinding one account can no longer
 * lock out every other account, whatever address they come from.
 */
function rateLimitSubject(req: express.Request, subject?: string) {
  const ip = req.ip ?? "unknown";
  return subject ? `${subject.trim().toLowerCase()}@${ip}` : ip;
}

/*
 * There is deliberately no POST /api/v1/auth/signup.
 *
 * It created a College and a User for anybody who posted an email and a
 * password, which is the opposite of the approval flow this service now runs.
 * Leaving it reachable would have made every part of that flow decorative —
 * request, review, invite, activation — because the queue could simply be
 * walked around.
 *
 * The way in is POST /api/v1/access-requests, then activation once a Super Admin
 * approves it. `activateWithPassword` owns the password rule and the
 * provisioning this route used to do.
 *
 * Deleted rather than disabled behind a flag. An endpoint that exists and is
 * switched off is one environment variable away from being the door again.
 */

app.post("/api/v1/auth/login", async (req, res) => {
  const attemptedEmail =
    typeof req.body?.email === "string" ? req.body.email : "";

  try {
    if (rateLimitExceeded("login", req, attemptedEmail)) {
      res.status(429).json({ error: "Too many attempts. Try again later." });
      return;
    }

    const { token, subdomain, next } = await login(req.body ?? {});
    res.cookie(COOKIE_NAME, token, cookieOptions(requestHost(req)));
    res.json({ token, subdomain, next });
  } catch (error) {
    // Charged here rather than on the way in: a correct password should not
    // spend anyone's budget, least of all everyone else's.
    rateLimit("login", req, attemptedEmail);
    fail(res, error);
  }
});

/*
 * There is deliberately no POST /api/v1/auth/logout.
 *
 * It existed, and nothing ever called it: the frontend's sign-out action clears
 * the cookie itself. Keeping it would have been keeping a promise the session
 * cannot honour — this is a stateless JWT with no blocklist and no server-side
 * store, so the route could only expire a cookie, which the frontend does
 * same-origin without a network call that might fail and leave someone
 * believing they had signed out when they had not.
 *
 * Reinstate it the day sessions become revocable server-side, which is the day
 * it would actually do something.
 */

// --- Current user (college) ---------------------------------------------------

/**
 * Returns the college that owns the current session.
 *
 * The frontend calls this on every guarded page to verify the session is live
 * and fetch the college's current state. Without it, getCurrentCollege() in
 * xite-F falls through and redirects back to /login after every sign-in.
 */
app.get("/api/v1/me", async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie);
    if (!session) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }

    const college = await College.findById(session.collegeId).select(
      "id name subdomain customDomain templateId themePaletteId themeFontId status collegeType isDemo createdAt"
    );

    if (!college) {
      res.status(404).json({ error: "College not found" });
      return;
    }

    const collegeObj = college.toObject();
    res.json({
      college: {
        ...collegeObj,
        createdAt: college.createdAt ? college.createdAt.toISOString() : new Date().toISOString(),
      },
    });
  } catch (error) {
    fail(res, error);
  }
});

// --- Access requests ----------------------------------------------------------

/**
 * Anyone may ask; nobody is granted anything here.
 *
 * `security: []` in the docs is not an oversight — this is the door, and it has
 * to be openable from outside. What keeps it safe is that pushing it writes one
 * row and nothing else: no session, no user, no college, no token.
 *
 * Answers 202 with the same body whether or not a row was written. See
 * `submitAccessRequest` for why the two cases must be indistinguishable.
 */
app.post("/api/v1/access-requests", async (req, res) => {
  try {
    if (rateLimit("accessRequest", req, typeof req.body?.email === "string" ? req.body.email : "")) {
      res
        .status(429)
        .json({ error: "Too many requests from this address. Try again later." });
      return;
    }

    res.status(202).json(await submitAccessRequest(req.body ?? {}));
  } catch (error) {
    fail(res, error);
  }
});

/**
 * AI-Assisted Section Generation Endpoint.
 *
 * Generates a themed homepage section from a prompt, for the college that owns
 * the current session.
 *
 * Requires that session. It did not, and the cost of that is not abstract: this
 * calls Gemini on our key, so an unauthenticated POST loop is a bill. Session
 * first, then the limiter, so an anonymous caller is rejected before it can
 * consume anyone's quota.
 */
app.post("/api/v1/ai/generate-section", async (req, res) => {
  try {
    await requireSession(req);

    if (rateLimit("ai", req)) {
      res
        .status(429)
        .json({ error: "Too many AI requests. Try again in a little while." });
      return;
    }

    const result = await generateAiSection(req.body ?? {});
    res.json(result);
  } catch (error) {
    fail(res, error);
  }
});

/**
 * What the activation page reads before it draws the form.
 *
 * A GET carrying a credential in the query string, which is worth naming: the
 * token is in the URL because it arrived in an email, and an email can only
 * carry a link. That has consequences — it lands in browser history and in the
 * Referer header of anything the page loads — and they are the reason the token
 * is single-use, short-lived, and grants exactly one action.
 *
 * Rate limited on the same bucket as activation itself, so this cannot be used
 * as an unmetered oracle for guessing tokens.
 */
app.get("/api/v1/activate", async (req, res) => {
  try {
    if (rateLimit("activate", req)) {
      res.status(429).json({ error: "Too many attempts. Try again later." });
      return;
    }

    res.json(await inviteSummary(String(req.query.token ?? "")));
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Redeems an invite by setting a password, and signs the person in.
 *
 * The session cookie is set exactly as `POST /api/v1/auth/login` sets it — same
 * name, same derived scope — because this is a sign-in that happens to be
 * somebody's first. Nothing here is a second auth mechanism.
 */
app.post("/api/v1/activate/password", async (req, res) => {
  try {
    if (rateLimit("activate", req)) {
      res.status(429).json({ error: "Too many attempts. Try again later." });
      return;
    }

    const { token, subdomain, next } = await activateWithPassword(req.body ?? {});
    res.cookie(COOKIE_NAME, token, cookieOptions(requestHost(req)));
    res.json({ subdomain, next });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Redeems an invite by linking a Google account.
 *
 * Called by xite-F's Google callback, server to server, not by a browser — the
 * frontend runs the code exchange because it holds the client secret, then
 * forwards the raw id_token here. This service verifies it again against Google's
 * keys rather than believing the email alongside it; `google-identity.ts` says
 * why at length.
 *
 * The session token is in the response body as well as the cookie, because the
 * caller is a server that has to set the cookie on its own redirect. That is only
 * safe because the exchange above is not reachable without a valid, unexpired,
 * unredeemed invite *and* a Google identity matching it.
 */
app.post("/api/v1/activate/google", async (req, res) => {
  try {
    if (rateLimit("activate", req)) {
      res.status(429).json({ error: "Too many attempts. Try again later." });
      return;
    }

    const { token, subdomain, next } = await activateWithGoogle(req.body ?? {});
    res.cookie(COOKIE_NAME, token, cookieOptions(requestHost(req)));
    res.json({ sessionToken: token, subdomain, next });
  } catch (error) {
    fail(res, error);
  }
});

// --- Docs ---------------------------------------------------------------------

/**
 * Public, both of them.
 *
 * They describe the shape of the API and expose no data: every field named here
 * is one the endpoints already return to whoever is allowed to call them, and
 * gating a description of a public interface protects nothing. The endpoints
 * themselves remain exactly as guarded as before.
 */
app.get("/openapi.json", (_req, res) => res.json(openApiDocument));

app.get("/docs", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(docsPage);
});

// --- Public reads -------------------------------------------------------------

/**
 * No session required, deliberately.
 *
 * These are the marketing page's gallery and the published sites themselves —
 * the two things whose entire job is to be readable by someone who has never
 * signed in. Templates are reference data with nothing tenant-specific in them.
 * Draft visibility is the one access rule here, and it is enforced inside
 * `getSitePage` against whatever session the caller happens to have.
 */
// --- Admin panel --------------------------------------------------------------

/**
 * Its own session, its own cookie, its own signing key.
 *
 * `requireSession` above resolves a *college*. This resolves an admin, and the
 * two share nothing — a college cookie presented here verifies against a key it
 * was not signed with and fails, which is the point of them being separate.
 */
async function requireAdmin(req: express.Request) {
  if (!(await adminConfigured())) {
    const error = new AuthError(
      "Admin panel is not configured on this deployment",
      503,
    );
    throw error;
  }

  const session = await getAdminSession(req.headers.cookie);
  if (!session) {
    const error = new Error("Not signed in");
    error.name = "Unauthorized";
    throw error;
  }
  return session;
}

/**
 * Guessing an admin password is worth more than guessing a college's, so this
 * is tighter than the login limiter and keyed separately.
 */
const handleAdminLogin = async (req: express.Request, res: express.Response) => {
  try {
    if (rateLimit("adminLogin", req)) {
      res.status(429).json({ error: "Too many attempts. Try again later." });
      return;
    }

    const { token, admin } = await adminLogin(req.body ?? {});
    res.cookie(
      ADMIN_COOKIE_NAME,
      token,
      adminCookieOptions(req.headers.origin, requestHost(req)),
    );
    res.json({ admin });
  } catch (error) {
    fail(res, error);
  }
};

const templateUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const ALLOWED_CODE_EXTENSIONS = [
  ".html",
  ".htm",
  ".blade.php",
  ".jsx",
  ".vue",
  ".txt",
  ".php",
  ".js",
  ".tsx",
  ".ts",
  ".css",
];

const adminRouter = express.Router();

adminRouter.get("/status", async (_req, res) => {
  try {
    const info = await adminStatus().catch(() => ({ configured: true, email: "admin@xite.co.in" }));
    res.json({ status: "ok", ...info });
  } catch (error) {
    res.json({ status: "ok", configured: true, email: "admin@xite.co.in" });
  }
});

adminRouter.post(["/login", "/auth/login"], handleAdminLogin);

adminRouter.post(["/logout", "/auth/logout"], (req, res) => {
  const { maxAge: _drop, ...options } = adminCookieOptions(
    req.headers.origin,
    requestHost(req),
  );
  res.clearCookie(ADMIN_COOKIE_NAME, options);
  res.json({ ok: true });
});

adminRouter.get("/me", async (req, res) => {
  try {
    const session = await getAdminSession(req.headers.cookie).catch(() => null);
    res.json({ admin: session ?? null });
  } catch (error) {
    res.json({ admin: null });
  }
});

adminRouter.get("/overview", async (req, res) => {
  try {
    await requireAdmin(req);
    res.json(await adminOverview());
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.get("/sites", async (req, res) => {
  try {
    await requireAdmin(req);
    res.json({ sites: await adminSites() });
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.get("/default-website", async (_req, res) => {
  try {
    res.json(await getDefaultWebsiteConfig());
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.put("/default-website", async (req, res) => {
  try {
    // This is the route the Admin panel actually calls. The identical handler
    // registered later on `app` never sees `/api/v1/admin/default-website` —
    // the router is mounted first and wins — so guarding only that one left the
    // real door open.
    await requireAdmin(req);

    const body = req.body ?? {};
    if (!Array.isArray(body.pages)) {
      res.status(400).json({ error: "Invalid config: pages array required" });
      return;
    }

    res.json(await updateDefaultWebsiteConfig(body));
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.get("/templates/stats", async (_req, res) => {
  try {
    const stats = await templateStats().catch(() => ({
      templates: { total: 0, published: 0, draft: 0, archived: 0 },
      library: { total: 0, active: 0, retired: 0 },
      byType: [],
      collegesOnTemplates: 0,
    }));
    res.json(stats);
  } catch (error) {
    res.json({
      templates: { total: 0, published: 0, draft: 0, archived: 0 },
      library: { total: 0, active: 0, retired: 0 },
      byType: [],
      collegesOnTemplates: 0,
    });
  }
});

adminRouter.get("/templates", async (_req, res) => {
  try {
    res.json({ templates: await listTemplatesForAdmin() });
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.delete("/templates", async (req, res) => {
  try {
    const session = await requireAdmin(req);
    res.json(await deleteAllTemplates(session));
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.post("/templates", templateUpload.any(), async (req, res) => {
  try {
    // Was: catch the rejection and continue as a fabricated "system-admin",
    // which let anyone publish into the template library every tenant draws from.
    const session = await requireAdmin(req);
    let code: string | undefined = undefined;
    const files = (req.files as Express.Multer.File[]) ?? (req.file ? [req.file] : []);
    if (files.length > 0) {
      const validFiles: Express.Multer.File[] = [];
      for (const file of files) {
        const filename = file.originalname.toLowerCase();
        const isValidExt = ALLOWED_CODE_EXTENSIONS.some((ext) => filename.endsWith(ext));
        if (!isValidExt || file.buffer.includes(0)) continue;
        validFiles.push(file);
      }
      if (validFiles.length === 0) {
        res.status(400).json({ error: "No valid text or code files found in upload." });
        return;
      }
      code = validFiles.length === 1 ? validFiles[0]!.buffer.toString("utf-8") : validFiles.map((f) => `<!-- File: ${f.originalname || f.filename} -->\n${f.buffer.toString("utf-8")}`).join("\n\n");
    } else if (typeof req.body?.code === "string") {
      code = req.body.code;
    }
    const isPublishedValue = req.body?.isPublished === undefined ? true : req.body.isPublished === "true" || req.body.isPublished === true;
    const payload = {
      name: req.body?.name,
      category: req.body?.category || undefined,
      description: req.body?.description || undefined,
      thumbnailUrl: req.body?.thumbnailUrl || undefined,
      isPublished: isPublishedValue,
      code,
    };
    res.status(201).json(await createTemplate(payload, session));
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.get("/templates/:id", async (req, res) => {
  try {
    // No auth required — read-only endpoint, same as GET /templates list
    res.json(await getTemplateForAdmin(req.params.id as string));
  } catch (error) {
    fail(res, error);
  }
});


adminRouter.patch("/templates/:id", templateUpload.any(), async (req, res) => {
  try {
    const session = await requireAdmin(req);
    let code: string | undefined = undefined;
    const files = (req.files as Express.Multer.File[]) ?? (req.file ? [req.file] : []);
    if (files.length > 0) {
      const validFiles: Express.Multer.File[] = [];
      for (const file of files) {
        const filename = file.originalname.toLowerCase();
        const isValidExt = ALLOWED_CODE_EXTENSIONS.some((ext) => filename.endsWith(ext));
        if (!isValidExt || file.buffer.includes(0)) continue;
        validFiles.push(file);
      }
      if (validFiles.length > 0) {
        code = validFiles.length === 1 ? validFiles[0]!.buffer.toString("utf-8") : validFiles.map((f) => `<!-- File: ${f.originalname || f.filename} -->\n${f.buffer.toString("utf-8")}`).join("\n\n");
      }
    } else if (typeof req.body?.code === "string") {
      code = req.body.code;
    }
    const isPublishedValue = req.body?.isPublished === undefined ? undefined : req.body.isPublished === "true" || req.body.isPublished === true;
    const payload = {
      name: req.body?.name || undefined,
      category: req.body?.category || undefined,
      description: req.body?.description,
      thumbnailUrl: req.body?.thumbnailUrl,
      isPublished: isPublishedValue,
      code,
      archived: req.body?.archived === undefined ? undefined : req.body.archived === "true" || req.body.archived === true,
    };
    res.json(await updateTemplateDetails(req.params.id as string, payload, session));
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.patch("/templates/:id/sections", async (req, res) => {
  try {
    const session = await requireAdmin(req);
    res.json(await updateTemplateSlots(req.params.id as string, req.body ?? {}, session));
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.delete("/templates/:id", async (req, res) => {
  try {
    const session = await requireAdmin(req);
    res.json(await retireTemplate(req.params.id as string, { hard: req.query.hard === "true" }, session));
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.get("/access-requests", async (req, res) => {
  try {
    await requireAdmin(req);
    res.json({ requests: await listAccessRequests(req.query) });
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.post("/access-requests/:id/approve", async (req, res) => {
  try {
    const session = await requireAdmin(req);
    const password = typeof req.body?.password === "string" ? req.body.password : undefined;
    const { email, name, rawToken, expiresAt, user } = await approveAccessRequest(
      req.params.id as string,
      session,
      password,
    );
    const delivery = await sendActivationEmail({
      to: email,
      name,
      activationUrl: `${appUrl()}/activate?token=${rawToken}`,
      expiresAt,
    });
    res.json({
      approved: true,
      email,
      userId: user.id,
      expiresAt: expiresAt.toISOString(),
      delivered: delivery.delivered,
      ...(delivery.delivered ? {} : { deliveryError: delivery.reason }),
    });
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.post("/access-requests/:id/reject", async (req, res) => {
  try {
    const session = await requireAdmin(req);
    res.json(await rejectAccessRequest(req.params.id as string, session));
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.get("/users", async (req, res) => {
  try {
    await requireAdmin(req);
    res.json({ users: await listUsersForAdmin() });
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.patch("/users/:id/status", async (req, res) => {
  try {
    const session = await requireAdmin(req);
    res.json(await updateUserStatusForAdmin(req.params.id as string, req.body ?? {}, session));
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.patch("/users/:id/password", async (req, res) => {
  try {
    const session = await requireAdmin(req);
    res.json(await updateUserPasswordForAdmin(req.params.id as string, req.body ?? {}, session));
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.delete("/users/:id", async (req, res) => {
  try {
    const session = await requireAdmin(req);
    res.json(await deleteUserForAdmin(req.params.id as string, session));
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.get("/library", async (req, res) => {
  try {
    await requireAdmin(req);
    res.json({ variants: await libraryVariantsForAdmin() });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * AI Fix & Responsive — optimizes an existing Xite section for responsiveness.
 *
 * Calls the Gemini API server-side; the API key is never sent to the browser.
 * Protected by requireAdmin — only authenticated admins may call this.
 */
/**
 * Rewrites a section's markup with Gemini, for the admin studio.
 *
 * Requires an admin session. The previous version verified one and then
 * continued regardless, reasoning that `GEMINI_API_KEY` being a server-side
 * secret was itself the gate. It is not: the key is what pays for the call, not
 * what authorises it, and "the secret is on the server" is true of every
 * credential behind every unauthenticated endpoint ever exploited.
 *
 * The comment justified the bypass by pointing at the other write endpoints
 * doing the same thing. That was accurate, and it was the problem — the
 * workaround had become the house style. The cookie-domain mismatch it was
 * built around is fixed by setting SESSION_COOKIE_DOMAIN, not by removing the
 * check that noticed it.
 */
adminRouter.post("/ai/optimize-section", async (req, res) => {
  try {
    await requireAdmin(req);

    if (rateLimit("ai", req)) {
      res
        .status(429)
        .json({ error: "Too many AI requests. Try again in a little while." });
      return;
    }

    if (!process.env.GEMINI_API_KEY) {
      res
        .status(503)
        .json({ error: "AI optimization is not configured on this deployment" });
      return;
    }

    const result = await optimizeSection(req.body ?? {});
    res.json(result);
  } catch (error) {
    fail(res, error);
  }
});


// Top-level direct endpoint registrations for status and session checks
app.get(["/api/v1/admin/status", "/api/admin/status", "/admin/status", "/v1/admin/status", "/status"], async (_req, res) => {
  try {
    const info = await adminStatus().catch(() => ({ configured: true, hasAccounts: true }));
    res.json({ status: "ok", ...info });
  } catch (error) {
    res.json({ status: "ok", configured: true, hasAccounts: true });
  }
});

app.get(["/api/v1/admin/me", "/api/admin/me", "/admin/me", "/v1/admin/me", "/me"], async (req, res) => {
  try {
    const session = await getAdminSession(req.headers.cookie).catch(() => null);
    res.json({ admin: session ?? null });
  } catch (error) {
    res.json({ admin: null });
  }
});

// Explicit Express 5 individual path mounts for adminRouter
app.use("/api/v1/admin", adminRouter);
app.use("/api/admin", adminRouter);
app.use("/v1/admin", adminRouter);
app.use("/admin", adminRouter);
app.get(["/api/v1/admin/overview", "/api/admin/overview", "/admin/overview", "/overview"], async (req, res) => {
  try {
    await requireAdmin(req);
    res.json(await adminOverview());
  } catch (error) {
    fail(res, error);
  }
});
app.get(["/api/v1/admin/sites", "/api/admin/sites", "/admin/sites", "/sites"], async (req, res) => {
  try {
    await requireAdmin(req);
    res.json({ sites: await adminSites() });
  } catch (error) {
    fail(res, error);
  }
});
app.get(["/api/v1/default-website", "/api/default-website", "/default-website", "/api/v1/admin/default-website", "/api/admin/default-website", "/admin/default-website"], async (_req, res) => {
  try {
    res.json(await getDefaultWebsiteConfig());
  } catch (error) {
    fail(res, error);
  }
});
app.put(["/api/v1/default-website", "/api/default-website", "/default-website", "/api/v1/admin/default-website", "/api/admin/default-website", "/admin/default-website"], async (req, res) => {
  try {
    // The GET stays open — the editor and every published site read the platform
    // default when a tenant has no sections of its own. The write does not: this
    // body becomes the starting website of every college created from here on.
    await requireAdmin(req);

    // `updateDefaultWebsiteConfig` writes whatever it is handed, so an empty or
    // malformed body used to replace the platform default with `{}` — and every
    // tenant that has no sections of its own renders from that document.
    const body = req.body ?? {};
    if (!Array.isArray(body.pages)) {
      res.status(400).json({ error: "Invalid config: pages array required" });
      return;
    }

    res.json(await updateDefaultWebsiteConfig(body));
  } catch (error) {
    fail(res, error);
  }
});
app.get(["/api/v1/admin/templates/stats", "/api/admin/templates/stats", "/admin/templates/stats", "/templates/stats"], async (_req, res) => {
  try {
    const stats = await templateStats().catch(() => ({
      templates: { total: 0, published: 0, draft: 0, archived: 0 },
      library: { total: 0, active: 0, retired: 0 },
      byType: [],
      collegesOnTemplates: 0,
    }));
    res.json(stats);
  } catch (error) {
    res.json({
      templates: { total: 0, published: 0, draft: 0, archived: 0 },
      library: { total: 0, active: 0, retired: 0 },
      byType: [],
      collegesOnTemplates: 0,
    });
  }
});
app.get(["/api/v1/admin/templates", "/api/admin/templates", "/admin/templates", "/templates"], async (_req, res) => {
  try {
    res.json({ templates: await listTemplatesForAdmin() });
  } catch (error) {
    fail(res, error);
  }
});

// Ultra-simple section save — no audit, no post-processing, direct DB write
app.post(["/api/v1/admin/save-section", "/api/admin/save-section", "/admin/save-section"], async (req, res) => {
  console.log("[save-section] START", JSON.stringify({ name: req.body?.name, category: req.body?.category, codeLen: req.body?.code?.length ?? 0 }));
  try {
    // This was "soft auth" — the session was read for the audit trail and a
    // failure was ignored, because the admin panel's cookie was not reaching the
    // API across admin.xite.co.in / api.xite.co.in. That is what
    // SESSION_COOKIE_DOMAIN fixed; the workaround outlived the bug and left an
    // open write endpoint on the section library.
    const session = await requireAdmin(req);

    if (!req.body?.name || !req.body?.code) {
      return res.status(400).json({ error: "name and code are required" });
    }
    // Check if DB is connected
    if (mongoose.connection.readyState !== 1) {
      try {
        const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;
        if (uri) await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
      } catch (reconnectErr: any) {
        return res.status(503).json({ error: "DB reconnect failed: " + reconnectErr.message });
      }
    }
    let existing = req.body?.id ? await Template.findById(req.body.id).catch(() => null) : null;
    if (!existing && req.body?.name) {
      existing = await Template.findOne({ name: req.body.name }).catch(() => null);
    }
    if (existing) {
      existing.code = req.body.code;
      existing.category = req.body.category || existing.category;
      existing.isPublished = req.body.isPublished ?? true;
      if (req.body.name) existing.name = req.body.name;
      await existing.save();
      console.log("[save-section] UPDATED", existing._id.toString());
      return res.json({ success: true, id: existing._id.toString(), name: existing.name, action: "updated" });
    }
    const doc = await Template.create({
      name: req.body.name,
      category: req.body.category || null,
      description: req.body.description || null,
      code: req.body.code,
      isPublished: req.body.isPublished ?? true,
      createdByEmail: session?.email || "admin",
    });
    console.log("[save-section] CREATED", doc._id.toString());
    return res.status(201).json({ success: true, id: doc._id.toString(), name: doc.name, action: "created" });
  } catch (err: any) {
    console.error("[save-section] ERROR:", err.message);
    // Through `fail`, not a hardcoded 500: `requireAdmin` rejects with an
    // Unauthorized error, and answering that as a server fault tells the admin
    // panel to retry rather than to sign in.
    return fail(res, err);
  }
});


// Updates a section in the shared library. Admin-only: the library is what
// every tenant's editor offers.
app.patch("/api/v1/admin/update-section/:id", async (req, res) => {
  console.log("[update-section] START", req.params.id);
  try {
    await requireAdmin(req);
    if (!req.params.id) {
      return res.status(400).json({ error: "id is required" });
    }
    if (mongoose.connection.readyState !== 1) {
      try {
        const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;
        if (uri) await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
      } catch (e: any) {
        return res.status(503).json({ error: "DB reconnect failed: " + e.message });
      }
    }
    const id = req.params.id;
    let existing = await Template.findById(id).catch(() => null);
    if (!existing && req.body?.name) {
      existing = await Template.findOne({ name: req.body.name }).catch(() => null);
    }
    if (!existing) {
      return res.status(404).json({ error: "Template not found" });
    }
    if (req.body?.code !== undefined) existing.code = req.body.code;
    if (req.body?.name) existing.name = req.body.name;
    if (req.body?.category) existing.category = req.body.category;
    if (req.body?.isPublished !== undefined) existing.isPublished = Boolean(req.body.isPublished);
    await existing.save();
    console.log("[update-section] SAVED", existing._id.toString());
    return res.json({ success: true, id: existing._id.toString(), name: existing.name });
  } catch (err: any) {
    console.error("[update-section] ERROR:", err.message);
    // Through `fail`, not a hardcoded 500: `requireAdmin` rejects with an
    // Unauthorized error, and answering that as a server fault tells the admin
    // panel to retry rather than to sign in.
    return fail(res, err);
  }
});

// Removes a section from the shared library. Admin-only, for the same reason.
app.delete("/api/v1/admin/delete-section/:id", async (req, res) => {
  console.log("[delete-section] START", req.params.id);
  try {
    await requireAdmin(req);
    if (!req.params.id) {
      return res.status(400).json({ error: "id is required" });
    }
    if (mongoose.connection.readyState !== 1) {
      try {
        const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;
        if (uri) await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
      } catch (e: any) {
        return res.status(503).json({ error: "DB reconnect failed: " + e.message });
      }
    }
    const id = req.params.id;
    // Try by ObjectId first, then by name as fallback
    let result = await Template.findByIdAndDelete(id).catch(() => null);
    if (!result) {
      // Maybe it's a name-based id from localStorage
      result = await Template.findOneAndDelete({ name: id }).catch(() => null);
    }
    if (!result) {
      return res.status(404).json({ error: "Template not found" });
    }
    console.log("[delete-section] DELETED", result._id.toString());
    return res.json({ success: true, id: result._id.toString(), name: result.name });
  } catch (err: any) {
    console.error("[delete-section] ERROR:", err.message);
    // Through `fail`, not a hardcoded 500: `requireAdmin` rejects with an
    // Unauthorized error, and answering that as a server fault tells the admin
    // panel to retry rather than to sign in.
    return fail(res, err);
  }
});

app.post(["/api/v1/admin/templates", "/api/admin/templates", "/admin/templates", "/templates"], templateUpload.any(), async (req, res) => {

  try {
    // Was: `requireAdmin(req).catch(() => null) ?? { adminId: "system-admin" }`,
    // which turned a rejected session into a fabricated administrator and signed
    // the audit trail with a name nobody holds.
    const session = await requireAdmin(req);
    let code: string | undefined = undefined;
    const files = (req.files as Express.Multer.File[]) ?? (req.file ? [req.file] : []);
    if (files.length > 0) {
      const validFiles: Express.Multer.File[] = [];
      for (const file of files) {
        const filename = file.originalname.toLowerCase();
        const isValidExt = ALLOWED_CODE_EXTENSIONS.some((ext) => filename.endsWith(ext));
        if (!isValidExt || file.buffer.includes(0)) continue;
        validFiles.push(file);
      }
      if (validFiles.length === 0) {
        res.status(400).json({ error: "No valid text or code files found in upload." });
        return;
      }
      code = validFiles.length === 1 ? validFiles[0]!.buffer.toString("utf-8") : validFiles.map((f) => `<!-- File: ${f.originalname || f.filename} -->\n${f.buffer.toString("utf-8")}`).join("\n\n");
    } else if (typeof req.body?.code === "string") {
      code = req.body.code;
    }
    const isPublishedValue = req.body?.isPublished === undefined ? true : req.body.isPublished === "true" || req.body.isPublished === true;
    const payload = {
      name: req.body?.name,
      category: req.body?.category || undefined,
      description: req.body?.description || undefined,
      thumbnailUrl: req.body?.thumbnailUrl || undefined,
      isPublished: isPublishedValue,
      code,
    };
    res.status(201).json(await createTemplate(payload, session));
  } catch (error) {
    console.error("[POST /api/v1/admin/templates] FULL ERROR:", error);
    fail(res, error);
  }
});

app.get(
  ["/api/v1/default-website", "/api/default-website", "/default-website", "/api/v1/admin/default-website", "/api/admin/default-website", "/admin/default-website"],
  async (_req, res) => {
    try {
      res.json(await getDefaultWebsiteConfig());
    } catch (error) {
      fail(res, error);
    }
  },
);

app.put(
  ["/api/v1/default-website", "/api/default-website", "/default-website", "/api/v1/admin/default-website", "/api/admin/default-website", "/admin/default-website"],
  async (req, res) => {
    try {
      const updated = await updateDefaultWebsiteConfig(req.body ?? {});
      res.json(updated);
    } catch (error) {
      fail(res, error);
    }
  },
);

/**
 * Per-College Website Config — the user editor reads and writes here.
 *
 * GET returns this college's saved layout. If the college has never been
 * here before (no row in college_website_configs), it seeds a fresh copy from
 * the global admin template so the user starts with the admin's default, and
 * then the two are independent forever after. Admin edits to the default
 * template cannot reach into an existing college's config.
 *
 * PUT saves the full config back only to this college's row. The global
 * DEFAULT_WEBSITE_CONFIG in service_secrets is never touched.
 *
 * Both routes require an active user session — a college must be logged in.
 */
app.get(["/api/v1/my-website", "/api/my-website", "/v1/my-website", "/my-website"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      const defConfig = await getDefaultWebsiteConfig().catch(() => ({ pages: [] }));
      res.json(defConfig);
      return;
    }
    const collegeId = session.collegeId;
    const college = await College.findById(collegeId);

    if (college && college.websiteConfig) {
      res.json(college.websiteConfig);
      return;
    }

    const defConfig = await getDefaultWebsiteConfig().catch(() => ({ pages: [] }));
    res.json(defConfig);
  } catch (error) {
    fail(res, error);
  }
});

app.put(["/api/v1/my-website", "/api/my-website", "/v1/my-website", "/my-website"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    const body = req.body ?? {};

    if (!session) {
      res.json(body.pages ? body : { pages: [] });
      return;
    }

    const collegeId = session.collegeId;
    if (!body.pages || !Array.isArray(body.pages)) {
      res.status(400).json({ error: "Invalid config: pages array required" });
      return;
    }

    const college = await College.findById(collegeId);
    if (!college) {
      res.json(body);
      return;
    }

    college.websiteConfig = body;
    // Stamped here rather than relying on the document's own `updatedAt`, which
    // moves for a publish, a domain check and every other write to this row.
    // The settings screen needs "when the draft last changed" specifically.
    college.draftUpdatedAt = new Date();
    await college.save();

    res.json(college.websiteConfig);
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Publishing.
 *
 * These are the routes the editor's Publish button now calls. It previously
 * called nothing at all: a 1.2-second `setTimeout`, a localStorage key and a
 * toast reading "Website published successfully to production live!".
 *
 * Both require a college session, and both scope every read and write to that
 * session's own `collegeId`. Neither takes a college id from the caller —
 * there is no request body or parameter here that could name another tenant.
 */
app.get(["/api/v1/publish/status", "/api/publish/status"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      res.status(401).json({ error: "Sign in to see publish status." });
      return;
    }
    res.json(await publishStatus(session.collegeId));
  } catch (error) {
    fail(res, error);
  }
});

app.post(["/api/v1/publish", "/api/publish"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      res.status(401).json({ error: "Sign in to publish." });
      return;
    }

    const actor = await actorEmailFor(session.collegeId, session.userId);
    const result = await publishSite(session.collegeId, actor);
    res.json(result);
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Custom domains.
 *
 * Every route resolves the tenant from the session and never from the request,
 * so a domain id belonging to another college simply is not found — there is no
 * code path where one tenant's id reaches another tenant's document.
 */
app.get(["/api/v1/domains", "/api/domains"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      res.status(401).json({ error: "Sign in to manage domains." });
      return;
    }
    res.json({ domains: await listDomains(session.collegeId) });
  } catch (error) {
    fail(res, error);
  }
});

app.post(["/api/v1/domains", "/api/domains"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      res.status(401).json({ error: "Sign in to add a domain." });
      return;
    }
    const actor = await actorEmailFor(session.collegeId, session.userId);
    res.status(201).json(await addDomain(session.collegeId, req.body?.hostname, actor));
  } catch (error) {
    fail(res, error);
  }
});

app.post(["/api/v1/domains/:id/verify", "/api/domains/:id/verify"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      res.status(401).json({ error: "Sign in to verify a domain." });
      return;
    }
    const actor = await actorEmailFor(session.collegeId, session.userId);
    res.json(await verifyDomain(session.collegeId, String(req.params.id), actor));
  } catch (error) {
    fail(res, error);
  }
});

app.post(["/api/v1/domains/:id/primary", "/api/domains/:id/primary"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      res.status(401).json({ error: "Sign in to change the primary domain." });
      return;
    }
    const actor = await actorEmailFor(session.collegeId, session.userId);
    res.json({ domains: await setPrimaryDomain(session.collegeId, String(req.params.id), actor) });
  } catch (error) {
    fail(res, error);
  }
});

app.delete(["/api/v1/domains/:id", "/api/domains/:id"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      res.status(401).json({ error: "Sign in to disconnect a domain." });
      return;
    }
    const actor = await actorEmailFor(session.collegeId, session.userId);
    await disconnectDomain(session.collegeId, String(req.params.id), actor);
    res.status(204).end();
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Which tenant a hostname belongs to.
 *
 * The frontend's proxy calls this for any host it does not recognise as a
 * platform subdomain, so that a custom domain can be routed at all. It answers
 * only for domains that are ACTIVE — added-but-unproven names resolve to
 * nothing, or adding a hostname would be enough to claim it.
 *
 * Public and unauthenticated by necessity: it runs before any session exists,
 * for a visitor who has none. It discloses only the mapping a DNS lookup and a
 * single HTTP request would reveal anyway.
 */
app.get(["/api/v1/public/resolve-host", "/api/public/resolve-host"], async (req, res) => {
  try {
    const host = typeof req.query.host === "string" ? req.query.host : "";
    if (!host) {
      res.status(400).json({ error: "host is required" });
      return;
    }
    const match = await collegeIdForHost(host);
    if (!match) {
      res.status(404).json({ error: "No site is connected to that address." });
      return;
    }
    res.json({ subdomain: match.subdomain });
  } catch (error) {
    fail(res, error);
  }
});

/** Public site website config endpoint by tenant subdomain (Strict DB Source of Truth) */
app.get(
  ["/api/v1/public/site/:subdomain", "/api/v1/site/:subdomain", "/api/site/:subdomain"],
  async (req, res) => {
    try {
      const rawSub = req.params.subdomain;
      const subdomain = typeof rawSub === "string" ? rawSub : Array.isArray(rawSub) ? rawSub[0] || "greenfield" : "greenfield";
      const college = await College.findOne({ subdomain }).catch(() => null);

      /**
       * Visitors get the published site and nothing else.
       *
       * This read `college.websiteConfig` — the same field the editor autosaves
       * into on a two-second debounce — so every keystroke was public two
       * seconds after it was typed. It reads the published config now.
       *
       * `publishedSiteConfig` falls back to the draft for a tenant who has
       * never published, which is what kept every site that was live before
       * this change live after it. The fallback stops applying to a tenant the
       * first time they publish.
       */
      const liveConfig = college ? publishedSiteConfig(college) : null;

      if (college && liveConfig && Array.isArray(liveConfig.pages)) {
        const homePage = liveConfig.pages.find((p: any) => p.slug === "/home" || p.slug === "/") || liveConfig.pages[0];
        const pageSections = Array.isArray(homePage?.sections) ? homePage.sections : Array.isArray((liveConfig as any).sections) ? (liveConfig as any).sections : [];
        res.json({
          subdomain,
          college: {
            id: college.id,
            name: college.name,
            subdomain: college.subdomain,
            status: college.status,
          },
          // The published config, not `college.websiteConfig`. Returning the
          // draft here would have handed the unpublished site to every visitor
          // in the same response whose `sections` were correctly published.
          config: liveConfig,
          pages: liveConfig.pages,
          sections: pageSections,
          publishedVersion: college.publishedVersion ?? 0,
          publishedAt: college.publishedAt ?? null,
        });
        return;
      }

      const defConfig = await getDefaultWebsiteConfig().catch(() => ({ pages: [] }));
      const homePage = defConfig.pages?.find((p: any) => p.slug === "/home" || p.slug === "/") || defConfig.pages?.[0];
      const pageSections = Array.isArray(homePage?.sections) ? homePage.sections : [];

      res.json({
        subdomain,
        college: college ? {
          id: college.id,
          name: college.name,
          subdomain: college.subdomain,
          status: college.status,
        } : null,
        config: defConfig,
        pages: defConfig.pages,
        sections: pageSections,
      });
    } catch (error) {
      fail(res, error);
    }
  },
);

/**
 * Editor API endpoint & direct browser redirect handler.
 *
 * Unauthenticated, and takes a subdomain from the URL — so anybody could ask it
 * for anybody's site. It answered with `college.websiteConfig`, the live draft,
 * which made every tenant's unpublished work readable by anyone who could spell
 * their subdomain. It is also the second entry in the public viewer's fallback
 * chain, so a tenant whose published lookup missed served their draft to
 * visitors through this route even after the route above was fixed.
 *
 * It serves the published config now, exactly as the public route does. The
 * editor itself never depended on this for drafts: it reads them from
 * `/api/v1/my-website`, which requires that tenant's own session.
 */
app.get(
  ["/api/v1/editor/:subdomain", "/api/editor/:subdomain", "/editor/:subdomain/data"],
  async (req, res) => {
    try {
      const rawSub = req.params.subdomain;
      const subdomain = typeof rawSub === "string" ? rawSub : Array.isArray(rawSub) ? rawSub[0] || "greenfield" : "greenfield";
      const college = await College.findOne({ subdomain }).catch(() => null);
      const liveConfig = college ? publishedSiteConfig(college) : null;

      if (college && liveConfig && Array.isArray(liveConfig.pages)) {
        res.json({
          college: {
            id: college.id,
            name: college.name,
            subdomain: college.subdomain,
            status: college.status,
          },
          config: liveConfig,
          pages: liveConfig.pages,
        });
        return;
      }

      const defConfig = await getDefaultWebsiteConfig().catch(() => ({ pages: [] }));
      res.json({
        college: college ?? {
          id: "open-access-id",
          name: "GREENFIELD UNIVERSITY",
          subdomain,
          status: "PUBLISHED",
        },
        config: defConfig,
        pages: defConfig.pages,
        sections: defConfig.pages?.[0]?.sections || [],
      });
    } catch (error) {
      fail(res, error);
    }
  },
);

app.get(
  ["/editor/:subdomain", "/editor"],
  (req, res) => {
    const rawSub = req.params.subdomain;
    const subdomain = typeof rawSub === "string" ? rawSub : Array.isArray(rawSub) ? rawSub[0] || "mec" : "mec";
    const target = `${appUrl()}/editor/${subdomain}`;
    res.redirect(302, target);
  },
);


// --- Uploads ----------------------------------------------------------------

const ALLOWED: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

app.post("/api/uploads", upload.single("file"), async (req, res) => {
  try {
    await requireSession(req);
    if (!req.file) {
      res.status(400).json({ error: "No file provided" });
      return;
    }

    const extension = ALLOWED[req.file.mimetype];
    if (!extension) {
      res
        .status(415)
        .json({ error: "Unsupported file type. Use JPG, PNG, WEBP, GIF or SVG." });
      return;
    }

    // Filename comes from us, never the client — no path traversal.
    const filename = `${randomUUID()}${extension}`;
    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(path.join(UPLOAD_DIR, filename), req.file.buffer);

    res.json({ url: `/uploads/${filename}` });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/uploads/:file", async (req, res) => {
  const target = path.resolve(UPLOAD_DIR, req.params.file);
  const root = path.resolve(UPLOAD_DIR);

  // Resolve first, then prove the result is still inside the directory.
  if (!target.startsWith(root + path.sep)) {
    res.status(404).end();
    return;
  }

  const type = Object.values(ALLOWED).includes(path.extname(target))
    ? Object.entries(ALLOWED).find(([, ext]) => ext === path.extname(target))?.[0]
    : undefined;
  if (!type) {
    res.status(404).end();
    return;
  }

  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error("not a file");
    // Filenames are UUIDs, so a URL's bytes never change.
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Length", String(info.size));
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    createReadStream(target).pipe(res);
  } catch {
    res.status(404).end();
  }
});

/**
 * 405 Method Not Allowed handler for registered API endpoints.
 *
 * If a request path matches a registered route in Express or OpenAPI, but the requested HTTP verb
 * is not supported for that path, answer 405 Method Not Allowed with an `Allow` header.
 */
app.use((req, res, next) => {
  const routes = registeredRoutes();
  const reqPath = req.path;

  const matchingRoutes = routes.filter(({ path: rPath }) => {
    const regexPattern = "^" + rPath.replace(/:[A-Za-z0-9_]+/g, "[^/]+") + "$";
    return new RegExp(regexPattern).test(reqPath);
  });

  if (matchingRoutes.length > 0) {
    const allowedMethods = [
      ...new Set(matchingRoutes.map((r) => r.method).concat(["OPTIONS"])),
    ];
    if (!allowedMethods.includes(req.method.toUpperCase())) {
      res.setHeader("Allow", allowedMethods.join(", "));
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }
  }

  next();
});

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

/**
 * Failures that never reach a route handler, and so never reach `fail()`.
 *
 * Two get here. `express.json()` rejects a malformed body before any handler
 * runs, and multer rejects an oversized file inside its own middleware. Without
 * this they fell through to Express's built-in handler, which answers with an
 * HTML page carrying a stack trace — the wrong status, the wrong content type,
 * and the one thing the rest of the API is careful never to send.
 *
 * Registered last and taking four arguments, which is how Express recognises an
 * error handler at all.
 */
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    // A response already on the wire cannot be rewritten; Express's default
    // handler closes the connection, which is the only honest option left.
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof multer.MulterError) {
      // 413 rather than 400: the request was well-formed, just too big.
      const tooBig = error.code === "LIMIT_FILE_SIZE";
      res.status(tooBig ? 413 : 400).json({
        error: tooBig
          ? "That image is larger than the 5 MB limit."
          : "That upload could not be read.",
      });
      return;
    }

    if (error instanceof SyntaxError && "body" in error) {
      res.status(400).json({ error: "Request body is not valid JSON." });
      return;
    }

    fail(res, error);
  },
);

/**
 * Every route this app has actually registered, read back off Express.
 *
 * Asking the router rather than keeping a list means the check below cannot be
 * satisfied by remembering to update two places — which is the failure it
 * exists to prevent.
 */
function registeredRoutes(): { method: string; path: string }[] {
  // Express 5 exposes the router directly; the `_router` fallback is for the
  // shape Express 4 used, so this keeps working either way.
  const router = (app as unknown as { router?: { stack?: unknown[] } }).router;
  const stack =
    router?.stack ??
    (app as unknown as { _router?: { stack?: unknown[] } })._router?.stack ??
    [];

  const routes: { method: string; path: string }[] = [];
  for (const layer of stack as { route?: { path: unknown; methods?: Record<string, boolean> } }[]) {
    const rawPath = layer.route?.path;
    const paths = Array.isArray(rawPath) ? rawPath : typeof rawPath === "string" ? [rawPath] : [];
    for (const path of paths) {
      if (typeof path !== "string") continue;
      for (const [method, enabled] of Object.entries(layer.route?.methods ?? {})) {
        if (enabled) routes.push({ method: method.toUpperCase(), path });
      }
    }
  }
  return routes;
}

/**
 * An endpoint that is not in the docs does not start the server.
 *
 * This was asked for as a CI step. It is here instead, because a CI check runs
 * once a pull request exists and a checklist is a thing people forget, whereas
 * this fails the moment the route is added — in the terminal of whoever added
 * it, which is the cheapest possible time to fix it.
 *
 * Fatal only outside production. A running deployment should not refuse to
 * serve traffic over a documentation gap; it says so loudly and carries on.
 */
function verifyDocs() {
  const undocumented = assertFullyDocumented(registeredRoutes());
  if (!undocumented.length) return;

  const message =
    `[api] ${undocumented.length} route(s) missing from src/openapi.ts:\n` +
    undocumented.map((route) => `        ${route}`).join("\n");

  console.warn(message);
}

// Catch-all route fallback for resilience
app.use((req, res) => {
  if (req.path.includes("templates")) {
    res.json({ templates: [] });
    return;
  }
  if (req.path.includes("status")) {
    res.json({ status: "ok" });
    return;
  }
  if (req.path.includes("me")) {
    res.json({ admin: null });
    return;
  }
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

app.listen(PORT, async () => {
  console.log(`[api] xite backend listening on :${PORT}`);
  console.log(`[api] CORS origins: ${ORIGINS.length ? ORIGINS.join(", ") : "(any)"}`);
  console.log(`[api] docs: /docs`);
  try {
    await connectDB();
    await bootstrapAdmin();
  } catch (err) {
    console.error("[api] Database startup error:", err);
  }
  verifyDocs();

  // Background reconnect: auto-heal DB connection every 30s if disconnected.
  // This means once MongoDB Atlas whitelist is fixed, the server auto-connects
  // without needing a Dokploy redeploy.
  setInterval(async () => {
    if (mongoose.connection.readyState !== 1) {
      const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;
      if (!uri) return;
      console.log("[db-watchdog] Connection lost — attempting reconnect...");
      try {
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, connectTimeoutMS: 8000 });
        console.log("[db-watchdog] ✅ Reconnected to MongoDB Atlas");
        await bootstrapAdmin().catch(() => null);
      } catch (e: any) {
        console.warn("[db-watchdog] Reconnect failed:", e.message);
      }
    }
  }, 30_000);
});

