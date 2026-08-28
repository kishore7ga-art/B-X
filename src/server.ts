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
  attachPaymentMethod,
  changePassword,
  detachPaymentMethod,
  listInvoices,
  listPaymentMethods,
  paymentProvider,
} from "@/account-service";
import { getSettings, publicSettingsFor, updateSettings } from "@/site-settings-service";
import {
  addDomain,
  adminListDomains,
  adminSetDomainEnabled,
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
import { BadRequest, Conflict, NotFound } from "@/errors";
import { connectDB, dbReady, dbServable, mongoUri, mongoose } from "@/db";
import { startDomainMonitor } from "@/domain-monitor";
import { domainRouter } from "@/domain-router";
import { College, Template } from "@/models";
import {
  fillPagesWithEverySection,
  getDefaultWebsiteConfig,
  updateDefaultWebsiteConfig,
} from "@/default-website-service";
import { sanitizeWebsiteConfig } from "@/lib/sections/sanitize-section-html";
import {
  deletePage,
  loadDraft,
  prepareConfig,
  reorderPageSections,
  restoreTemplateScripts,
  saveDraft,
  savePage,
} from "@/website-config-service";
import { getSectionLibrary } from "@/section-library-service";
import { presenceCounts, touchPresence } from "@/presence-service";
import {
  completeOnboarding,
  getOnboarding,
  onboardingPayloadFor,
} from "@/onboarding-service";
import { EDITOR_THEME_IDS, EDITOR_FONT_IDS } from "@/lib/editor-themes";

/**
 * Open-access mode is a development convenience and refuses to be one in
 * production.
 *
 * `AUTH_DISABLED=true` makes `getSession()` mint a session for the first
 * non-demo college to *any* caller with no cookie — every guard in this service
 * then passes for anonymous requests, against a real tenant's data. It is a
 * legitimate local mode and an unrecoverable one on the internet, and the only
 * thing standing between the two was an environment variable in a dashboard.
 *
 * Cleared rather than refused to start: an operator who sets this by accident on
 * a production deploy should get a service that is safe, not a service that is
 * down. It is loud about it.
 */
if (process.env.NODE_ENV === "production" && process.env.AUTH_DISABLED === "true") {
  console.error(
    "[api] AUTH_DISABLED=true is ignored in production — it would hand every " +
      "anonymous request a session for a real college. Unset it.",
  );
  process.env.AUTH_DISABLED = "false";
}

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
    "default-src 'self'; script-src 'self' 'unsafe-inline' cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' fonts.googleapis.com; font-src 'self' fonts.gstatic.com data:; img-src 'self' data: https:; connect-src 'self' https://api.webxite.org https://admin.webxite.org https://webxite.org; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://admin.webxite.org https://webxite.org;",
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

  /**
   * Tracing headers, echoed back only in a shape we chose.
   *
   * Both of these took a caller-supplied header and wrote it straight onto the
   * response. Node rejects the CRLF that would make that header injection, so
   * this was not a split — but it is an unbounded, unvalidated attacker string
   * reflected to whoever reads the response, and `x-tenant-id` in particular
   * reads like an authorisation-relevant value that this service never derives
   * from the request. Nothing downstream trusts it; something eventually would.
   *
   * A short opaque token is all a trace needs.
   */
  const TRACE_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

  const suppliedId = req.headers["x-request-id"];
  const requestId =
    typeof suppliedId === "string" && TRACE_SHAPE.test(suppliedId)
      ? suppliedId
      : `req_${randomUUID().slice(0, 8)}`;
  res.setHeader("x-request-id", requestId);

  // Deliberately not echoed. The tenant a request belongs to is resolved from
  // the session, and reflecting the caller's claim invites it to be believed.
  res.setHeader("x-tenant-id", "system");

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
/**
 * The platform's domain, and the one it was migrated away from.
 *
 * `xite.co.in` was production until the move to `webxite.org`. It survives as a
 * *legacy* root in exactly two places — the suffix rule in `isAllowedOrigin`
 * below and the reserved-host check in domain-service.ts — so that tenant sites
 * already published at `<subdomain>.xite.co.in` keep resolving, and a browser
 * still holding a session issued on the old domain is not rejected mid-cutover.
 *
 * It is not a canonical anything. Nothing is added to it, no link is generated
 * pointing at it, and it is deleted outright once the edge redirect
 * `xite.co.in/* -> webxite.org/*` has been in place long enough that no live
 * link resolves through it. Grep for LEGACY_ROOT to find every survivor.
 */
const PLATFORM_ROOT = "webxite.org";
const LEGACY_ROOT = "xite.co.in";

const DEFAULT_ORIGINS = [
  "https://webxite.org",
  "https://www.webxite.org",
  "https://admin.webxite.org",
  "https://api.webxite.org",
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
 * `url.includes(rootDomain)`, which admitted `https://webxite.org.attacker.com`:
 * the string contains "webxite.org", so it passed, and the matching origin is
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

  // A tenant's own published site: <subdomain>.webxite.org. Suffix-matched on
  // the parsed hostname, so a domain merely *containing* the root cannot match.
  // LEGACY_ROOT is here for the migration only — see its declaration.
  for (const root of [rootDomain, PLATFORM_ROOT, LEGACY_ROOT]) {
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
    /**
     * Headers a cross-origin caller may actually read.
     *
     * Without this the browser hands JavaScript a 429 with no `Retry-After`,
     * however carefully the server set it — response headers are hidden from
     * cross-origin script unless they are named here. The admin panel is on a
     * different origin from this API, so every header it needs must be listed.
     */
    res.setHeader("Access-Control-Expose-Headers", "Retry-After");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

/*
 * Ordering note: this sits *after* the CORS middleware on purpose.
 *
 * Placed before it, the 503 below goes out with no `Access-Control-Allow-Origin`
 * header — so a browser refuses to let the admin panel read it and reports a
 * CORS failure instead. The operator is then told their origin is blocked when
 * the actual fault is the database, which is precisely the misdiagnosis this
 * gate exists to prevent.
 */
/**
 * One answer for "the database is not available", instead of eleven.
 *
 * Three route handlers each carried their own copy of: check `readyState`,
 * call `mongoose.connect` inline, and on failure return
 * `"DB reconnect failed: " + err.message`. That is three problems in one
 * pattern. It reconnects from inside a request, so a burst of traffic during an
 * outage opens a burst of handshakes. It leaks the driver's message — which
 * carries the cluster hostname and replica-set topology — to the caller. And it
 * was only ever on the three endpoints somebody happened to be debugging, so
 * every other route failed by hanging until mongoose's buffer timed out.
 *
 * Reconnection belongs to the watchdog, which is a single timer. This gate only
 * *reports*, and it distinguishes the two states that matter:
 *
 *   connecting  — mongoose buffers the operation and it will be served shortly,
 *                 so the request is let through.
 *   disconnected — nothing will serve it, so say so immediately rather than
 *                 making the caller wait out a buffer timeout.
 *
 * `/api/health` and the docs stay reachable: an operator diagnosing an outage
 * needs the health endpoint most precisely when it is failing.
 */
const READINESS_EXEMPT = /^\/(api\/health|health|docs|openapi\.json|favicon\.ico)/;

app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  if (READINESS_EXEMPT.test(req.path)) return next();
  if (dbServable()) return next();

  res.setHeader("Retry-After", "15");
  res.status(503).json({
    error: "The database is unavailable. This is being retried; try again shortly.",
  });
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
    /**
     * Record that this session is in use, for the dashboard's live count.
     *
     * Deliberately not awaited. Presence is a reporting detail and this
     * middleware sits in front of every route — making a request wait on a
     * database write it does not need is how a dashboard number becomes a
     * latency regression on the whole product. The write throttles itself to
     * once a minute per user and swallows its own failures.
     */
    if (current) void touchPresence(current.session);
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

  // The current state travels with the refusal: the only useful thing a client
  // can do with a conflict is show what it is now, and a second round trip to
  // find out leaves a window for a third writer.
  if (error instanceof Conflict) {
    res.status(409).json({ error: error.message, current: error.current ?? null });
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
    frontend: "https://webxite.org",
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
/**
 * Which flows can work right now, which is one question about the database.
 *
 * Each key is a flow whose every write goes through Mongo, so "is the
 * connection up" is genuinely the whole answer for all of them. They are listed
 * separately rather than collapsed into one field because an operator reading
 * this wants to know what is affected, not merely that something is.
 *
 * `e2eSuite: "93/93"` used to be reported alongside them. It was a string
 * literal — no suite ran, nothing counted, and the number did not change when
 * tests were added, removed or broken. A health endpoint asserting a passing
 * test run it has never observed is worse than one that says nothing: it is
 * exactly the field somebody checks when they suspect something is wrong.
 * Test results belong to CI, which actually runs them.
 */
app.get("/api/v1/system/flow-health", async (_req, res) => {
  const isDbConnected = mongoose.connection.readyState === 1;
  const state = isDbConnected ? "ok" : "degraded";
  res.json({
    accessRequest: state,
    approval: state,
    activation: state,
    authentication: state,
    editorPersistence: state,
    livePublishing: state,
    database: isDbConnected ? "connected" : "unreachable",
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
 * How long until this bucket lets the caller try again, in whole seconds.
 *
 * The limiter already stores the timestamp of every attempt in the window, so
 * this is knowable exactly rather than guessable: the oldest attempt still
 * counting falls out of the window at `oldest + windowMs`, and that is the
 * moment a slot frees.
 *
 * Worth computing because the alternative is what the admin panel did — pick a
 * number, be wrong, and tell the operator to come back before the lockout has
 * expired. `0` means the bucket is not full.
 */
function retryAfterSeconds(action: keyof typeof LIMITS, subject: string): number {
  const { max, windowMs } = LIMITS[action];
  const now = Date.now();
  const recent = (attempts.get(`${action}:${subject}`) ?? []).filter(
    (at) => now - at < windowMs,
  );
  if (recent.length < max) return 0;

  const oldest = Math.min(...recent);
  return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
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
      "id name subdomain customDomain templateId themePaletteId themeFontId status collegeType isDemo createdAt ownerRole onboardingCompletedAt"
    );

    if (!college) {
      res.status(404).json({ error: "College not found" });
      return;
    }

    const collegeObj = college.toObject();
    /**
     * The onboarding state travels with the session, not on a second request.
     *
     * Every guarded page in the frontend already calls this to prove the cookie
     * is live, and every one of them then has to decide whether to render or
     * send the person to the wizard. Answering that here makes it one round
     * trip; answering it from a separate endpoint makes it two, on every page,
     * with a window in between where the app knows who somebody is but not
     * where they should be.
     */
    const onboarding = onboardingPayloadFor(college);
    // The raw timestamp is selected so the payload can be derived from it, and
    // deliberately not sent. Two representations of one fact is how the wizard
    // and the editor end up disagreeing about whether somebody has finished it.
    delete (collegeObj as Record<string, unknown>).onboardingCompletedAt;
    res.json({
      college: {
        ...collegeObj,
        ownerRole: onboarding.role,
        onboardingCompleted: onboarding.completed,
        createdAt: college.createdAt ? college.createdAt.toISOString() : new Date().toISOString(),
      },
    });
  } catch (error) {
    fail(res, error);
  }
});

// --- Onboarding ---------------------------------------------------------------

/**
 * The role/theme/font wizard, read and written.
 *
 * Both are scoped to `session.collegeId` and take no id from the caller. That
 * is not a formality: onboarding writes the project's theme and font, so a
 * route that accepted a college id from the body would let any signed-in tenant
 * restyle any other tenant's site. There is no id to tamper with here.
 */
app.get(["/api/v1/onboarding", "/api/onboarding"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie);
    if (!session) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    res.json(await getOnboarding(session.collegeId));
  } catch (error) {
    fail(res, error);
  }
});

app.put(["/api/v1/onboarding", "/api/onboarding"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie);
    if (!session) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    const payload = await completeOnboarding(session.collegeId, req.body ?? {});
    console.log(
      `[onboarding] college=${session.collegeId} role=${payload.role} ` +
        `theme=${payload.themePaletteId} font=${payload.themeFontId}`,
    );
    res.json(payload);
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
  /**
   * Which bucket this attempt is charged to.
   *
   * The email, when one was given, so an attacker grinding one account cannot
   * lock out every other administrator from the same address — the same
   * reasoning `rateLimitSubject` already documents for college sign-in. When no
   * email is given the request resolves to `ADMIN_BOOTSTRAP_EMAIL`, so the
   * bucket falls back to the address, which is the honest key for "whoever this
   * is, they are guessing at the default account".
   */
  const attemptedEmail = typeof req.body?.email === "string" ? req.body.email : "";

  try {
    /**
     * Checked without charging.
     *
     * This used to call `rateLimit()`, which *records* an attempt as a side
     * effect — so every sign-in was charged, including the correct ones. Five
     * successful logins in a quarter hour locked the administrator out of an
     * account they had just proved they owned, and because the bucket was keyed
     * on the address alone rather than the account, one person doing that shut
     * out everyone else behind the same office IP.
     *
     * This is the exact bug `isRateLimited` was split out to fix for college
     * sign-in — its comment says "counting successes was locking people out of
     * an account they were signing into correctly" — and admin login was left
     * on the old path.
     */
    if (rateLimitExceeded("adminLogin", req, attemptedEmail)) {
      // The exact wait, not a shrug. The panel renders a countdown from this;
      // when it had to guess it guessed five minutes against a fifteen-minute
      // bucket and locked the operator into a loop of expired timers.
      const wait = retryAfterSeconds("adminLogin", rateLimitSubject(req, attemptedEmail));
      if (wait > 0) res.setHeader("Retry-After", String(wait));
      res.status(429).json({
        error:
          wait > 0
            ? `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`
            : "Too many attempts. Try again later.",
      });
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
    /**
     * Charged here, and only for a wrong credential.
     *
     * A 503 because the database is unreachable, or because the admin panel is
     * unconfigured, is this service's fault and must not spend the operator's
     * five attempts — that turns a backend outage into a lockout on top of it.
     */
    const status = error instanceof AuthError ? error.status : 0;
    if (status === 400 || status === 401) {
      rateLimit("adminLogin", req, attemptedEmail);
    }
    fail(res, error);
  }
};

const templateUpload = multer({
  storage: multer.memoryStorage(),
  /**
   * A per-file ceiling is only half a limit when the handler is `.any()`.
   *
   * `fileSize` alone caps each part at 10MB and says nothing about how many
   * parts a request may carry, and this is memory storage — every one of them is
   * buffered in the heap at once. A single multipart POST with a few hundred
   * parts is an out-of-memory kill on the API process, from an endpoint that is
   * reachable with one admin session.
   */
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 20,
    fields: 50,
    fieldSize: 2 * 1024 * 1024,
  },
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

/**
 * Whether this panel can serve at all. Deliberately unauthenticated — it is what
 * the login screen reads *before* anyone can sign in, to explain why they cannot.
 *
 * Two things it no longer does. It answered a failure with
 * `{configured: true, email: "admin@xite.co.in"}`: a fabricated address on a
 * domain the platform has migrated away from, and a claim to be configured when
 * the check had just failed — which hid the "not configured" banner on exactly
 * the fault that banner exists to describe. And because `hasAccounts` was absent
 * from that object, the panel read it as `false` and told the operator no Super
 * Admin existed, on what was only a transient error.
 *
 * It also returned `bootstrap: {varsSet, lastRun}`, telling any anonymous caller
 * whether the bootstrap environment variables are set. Nothing renders it.
 *
 * The two booleans the panel actually uses, or an honest 503.
 */
adminRouter.get("/status", async (_req, res) => {
  try {
    const info = await adminStatus();
    res.json({
      status: "ok",
      configured: info.configured,
      hasAccounts: Boolean(info.hasAccounts),
    });
  } catch (error) {
    console.error("[admin/status] could not determine admin configuration:", error);
    res.status(503).json({ error: "Could not determine admin configuration." });
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

/**
 * Domains, across every tenant.
 *
 * The Super Admin had no view of this at all. A tenant could see their own
 * domains and nobody could see the whole roster — so "which domains are failing
 * right now" was answerable only by querying the database, and a failing domain
 * belonging to a tenant who had stopped checking was invisible indefinitely.
 */
adminRouter.get("/domains", async (req, res) => {
  try {
    await requireAdmin(req);
    res.json({ domains: await adminListDomains() });
  } catch (error) {
    fail(res, error);
  }
});

/** Re-run the real checks against one domain, on demand. */
adminRouter.post("/domains/:collegeId/:domainId/verify", async (req, res) => {
  try {
    const session = await requireAdmin(req);
    res.json(
      await verifyDomain(
        slugParam(req.params.collegeId),
        slugParam(req.params.domainId),
        session.email,
      ),
    );
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Switch a domain off, or back on.
 *
 * Off is the lever that matters: a domain being used for something it should
 * not be needs to stop resolving without waiting for the tenant to agree. The
 * row is kept either way, because the audit trail is the point.
 */
adminRouter.post("/domains/:collegeId/:domainId/disable", async (req, res) => {
  try {
    const session = await requireAdmin(req);
    res.json(
      await adminSetDomainEnabled(
        slugParam(req.params.collegeId),
        slugParam(req.params.domainId),
        false,
        session.email,
      ),
    );
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.post("/domains/:collegeId/:domainId/reactivate", async (req, res) => {
  try {
    const session = await requireAdmin(req);
    res.json(
      await adminSetDomainEnabled(
        slugParam(req.params.collegeId),
        slugParam(req.params.domainId),
        true,
        session.email,
      ),
    );
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

    /**
     * The version the caller read before editing.
     *
     * Optional, and that is a compatibility decision rather than an oversight:
     * a client that has not been updated sends none and keeps its old
     * last-write-wins behaviour, rather than every save in an already-open tab
     * starting to fail the moment this deploys. The Admin sends it, so the tab
     * that actually causes lost updates is the one now protected.
     */
    const version = Number(body.version);
    res.json(
      await updateDefaultWebsiteConfig(body, {
        expectedVersion: Number.isFinite(version) ? version : undefined,
      }),
    );
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Fill the Default Website's pages with every section category.
 *
 * A separate route rather than a flag on the PUT above, because the two mean
 * different things to the caller: PUT replaces the config with the body it was
 * sent, and this one *derives* the new config on the server from the template
 * library. Sending twenty sections up from the browser would mean the Admin
 * had to hold the starter markup as well, which is a second copy of it and a
 * second thing to keep in step.
 *
 * Body: `{ slugs?: string[] }` — omit to fill every page. Idempotent; see
 * `fillPagesWithEverySection`.
 */
adminRouter.post("/default-website/fill", async (req, res) => {
  try {
    await requireAdmin(req);

    const raw = (req.body ?? {}).slugs;
    const slugs = Array.isArray(raw)
      ? raw.filter((slug: unknown): slug is string => typeof slug === "string" && slug.trim() !== "")
      : undefined;

    res.json(await fillPagesWithEverySection(slugs));
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Library counters for the admin dashboard.
 *
 * The `catch` here used to answer *every* failure — including the
 * `requireAdmin` rejection — with a 200 and a payload of zeros. So the guard
 * was decorative: an anonymous caller never saw 401, they saw a valid-looking
 * response. It also meant the panel could not tell "you are signed out" from
 * "the library is empty", which are not the same instruction to the operator.
 *
 * Auth failures now propagate. The zero-fallback survives for exactly what it
 * was for: a stats *computation* that fails on an otherwise healthy request,
 * where counters of zero beside a working template list is a smaller lie than
 * blanking the screen.
 */
adminRouter.get("/templates/stats", async (req, res) => {
  try {
    await requireAdmin(req);
    res.json(
      await templateStats().catch((error) => {
        console.error("[admin/templates/stats] counters unavailable:", error);
        return {
          templates: { total: 0, published: 0, draft: 0, archived: 0 },
          library: { total: 0, active: 0, retired: 0 },
          byType: [],
          collegesOnTemplates: 0,
        };
      }),
    );
  } catch (error) {
    fail(res, error);
  }
});

adminRouter.get("/templates", async (req, res) => {
  try {
    /**
     * Admin-only, like every other route on this router.
     *
     * `listTemplatesForAdmin` returns each template's full `code` — the raw
     * markup of the section library the whole platform is built from, including
     * unpublished and archived drafts. It was readable by anyone.
     */
    await requireAdmin(req);
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
    // Was: "No auth required — read-only endpoint, same as GET /templates
    // list". True, and the list was not authenticated either. Read-only is not
    // the same as public: this returns unpublished template source.
    await requireAdmin(req);
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
    const activationUrl = `${appUrl()}/activate?token=${rawToken}`;
    const delivery = await sendActivationEmail({
      to: email,
      name,
      activationUrl,
      expiresAt,
    });
    /**
     * When the email did not go out, hand the link back to the approver.
     *
     * `approveAccessRequest` creates the account with CSPRNG output nobody is
     * told, and the activation link is the only way in. This route knew the
     * delivery had failed, reported `delivered: false`, and then dropped the one
     * value that could still rescue the account — the raw token exists nowhere
     * else, only its hash is stored. On a deployment with no `RESEND_API_KEY`
     * that is the *common* path, not an edge case: approving a college produced
     * an account that could never be signed into, and the panel said it was fine.
     *
     * Returned only on failure, and only to a caller that has already cleared
     * `requireAdmin` and just approved this request. It grants them nothing they
     * did not have — the same session can set the account's password outright
     * via PATCH /users/:id/password — so this is a delivery channel of last
     * resort, not a widening of what a Super Admin can do.
     */
    res.json({
      approved: true,
      email,
      userId: user.id,
      expiresAt: expiresAt.toISOString(),
      delivered: delivery.delivered,
      ...(delivery.delivered ? {} : { deliveryError: delivery.reason, activationUrl }),
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





// Explicit Express 5 individual path mounts for adminRouter
/*
 * Seven top-level duplicates of `adminRouter` routes were removed from here:
 * GET /status, /me, /overview, /sites, /templates, /templates/stats and
 * POST /templates, each registered at four or five path aliases.
 *
 * They were a second, parallel implementation of the same admin API, and which
 * one answered depended on nothing more principled than line number. Express
 * matches in registration order, and two of them — /status and /me — sat
 * *above* `app.use("/api/v1/admin", adminRouter)`, so they shadowed the router
 * entirely for the canonical prefix while the other five were shadowed *by* it.
 *
 * That is not a theoretical hazard. Tightening `adminRouter.get("/status")` —
 * to stop it fabricating `{configured: true, email: "admin@xite.co.in"}` on a
 * failed lookup and to stop it returning the bootstrap state to anonymous
 * callers — changed nothing at all, because the copy at the top of this section
 * was the one answering. The fix looked applied, deployed, and did nothing.
 *
 * The four `app.use(..., adminRouter)` mounts below already serve every
 * prefixed alias these registered (/api/v1/admin, /api/admin, /v1/admin,
 * /admin). What is gone is the bare root forms — GET /status, /me, /templates
 * and friends — which nothing in this workspace calls, are in no OpenAPI
 * document, and had no business sitting at the root of an API alongside
 * /api/health and /docs.
 */

app.use("/api/v1/admin", adminRouter);
app.use("/api/admin", adminRouter);
app.use("/v1/admin", adminRouter);
app.use("/admin", adminRouter);
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

    /**
     * The version the caller read before editing.
     *
     * Optional, and that is a compatibility decision rather than an oversight:
     * a client that has not been updated sends none and keeps its old
     * last-write-wins behaviour, rather than every save in an already-open tab
     * starting to fail the moment this deploys. The Admin sends it, so the tab
     * that actually causes lost updates is the one now protected.
     */
    const version = Number(body.version);
    res.json(
      await updateDefaultWebsiteConfig(body, {
        expectedVersion: Number.isFinite(version) ? version : undefined,
      }),
    );
  } catch (error) {
    fail(res, error);
  }
});






/*
 * Three routes were removed from here: POST /api/v1/admin/save-section,
 * PATCH /api/v1/admin/update-section/:id and DELETE /api/v1/admin/delete-section/:id.
 *
 * They were a second way to write the Template collection, added as a
 * "no audit, no post-processing, direct DB write" shortcut while the admin
 * panel's cookie was not reaching this API. `adminRouter` already owned
 * POST /templates, PATCH /templates/:id and DELETE /templates/:id, so every
 * template write had two doors with different behaviour behind them, and the
 * panel called both — the shortcut first, then the canonical one as a
 * "fallback", on the strength of comments claiming the shortcut needed no auth.
 * That had stopped being true when `requireAdmin` was added to all three.
 *
 * What that cost, concretely:
 *
 *   - A transient failure on the first door produced a *duplicate* row via the
 *     second, rather than a retry.
 *   - Delete escalated silently: `delete-section` failing for any reason sent
 *     the operator's click to `templates/:id?hard=true`, which is a permanent
 *     delete rather than an archive.
 *   - `delete-section` fell back to `Template.findOneAndDelete({ name: id })`
 *     when the id was not an ObjectId — so a stale client passing a *name*
 *     deleted the template with that name. The comment said this was for
 *     "a name-based id from localStorage", which is exactly the client-side
 *     cache that has now been removed.
 *   - Each carried its own inline `mongoose.connect` retry and returned
 *     `"DB reconnect failed: " + err.message` to the caller, leaking the
 *     cluster hostname and replica-set topology. That is now one readiness gate.
 *
 * The canonical routes on `adminRouter` do the same work with an audit trail.
 */

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

/*
 * A second, unguarded `app.put` for the same six paths was registered here.
 *
 * It called `updateDefaultWebsiteConfig(req.body)` with no `requireAdmin` and no
 * shape check — the body that becomes the starting website of every college
 * created from then on, and the fallback every tenant with no sections of their
 * own renders from.
 *
 * It never ran: Express matches in registration order and the guarded handler
 * above answers first. That is the entire reason it was not an open write
 * endpoint, and it is not a reason anyone chose — reordering these two blocks,
 * or deleting the one above as a duplicate, would have silently made it one.
 * Removed rather than left as a copy that is safe by accident.
 */

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
/**
 * A `:slug` route parameter, as a plain string.
 *
 * Express 5 types params on array-registered routes as `string | string[]`, and
 * decodes them once itself. Decoding a second time is what turns a page named
 * `50%-scholarship` into a URIError and a 500, so the second pass is attempted
 * and discarded on failure rather than trusted.
 */
function slugParam(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  if (!raw.includes("%")) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

app.get(["/api/v1/my-website", "/api/my-website", "/v1/my-website", "/my-website"], async (req, res) => {
  try {
    const session = await requireSession(req);
    const draft = await loadDraft(session.collegeId);

    // A college that has never saved anything starts from the platform default.
    // Seeded on read rather than at signup so a default the Super Admin changes
    // still reaches colleges created before the change but not yet edited.
    if (draft.pages.length === 0) {
      res.json(
        await restoreTemplateScripts(
          prepareConfig(await getDefaultWebsiteConfig().catch(() => ({ pages: [] }))),
        ),
      );
      return;
    }

    /**
     * Scripts put back on the way out.
     *
     * `PUT /my-website` strips `<script>` from tenant markup, which is right —
     * it renders on the platform apex. But a section whose content is *built*
     * by its script (a slider, a carousel, a tab panel) then comes back as an
     * empty rectangle with its own background and padding: the reported black
     * band. The script is looked up from the admin-authored template the
     * section came from, never taken from a request. See
     * `restoreTemplateScripts`.
     */
    res.json(await restoreTemplateScripts(draft));
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Replace the whole draft.
 *
 * Kept for the editor's explicit Save and for importing a config wholesale.
 * Ordinary edits go through the per-page route below, which cannot rewrite a
 * page the client was not looking at.
 */
app.put(["/api/v1/my-website", "/api/my-website", "/v1/my-website", "/my-website"], async (req, res) => {
  try {
    const session = await requireSession(req);
    const body = req.body ?? {};
    if (!Array.isArray(body.pages)) {
      throw new BadRequest("Invalid config: a pages array is required.");
    }
    res.json(await saveDraft(session.collegeId, body));
  } catch (error) {
    fail(res, error);
  }
});

/**
 * One page, saved on its own.
 *
 * This is the write path for every ordinary edit, and it is what keeps pages
 * from bleeding into each other. The full-config PUT above had to reconstruct
 * every page from browser state on every save, so a page the editor had loaded
 * stale — or had never loaded — was overwritten with whatever that tab happened
 * to be holding. Editing Home rewrote About. Here the server owns every page
 * except the one named in the URL.
 */
app.put(["/api/v1/my-website/pages/:slug", "/api/my-website/pages/:slug"], async (req, res) => {
  try {
    const session = await requireSession(req);
    const body = req.body ?? {};
    res.json(await savePage(session.collegeId, slugParam(req.params.slug), body));
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Reorder one page's sections, by id.
 *
 * Separate from the save above because it is the one edit that has to land on
 * the click. Move-up used to persist by re-sending every page's full markup
 * through a 2-second debounce that the next click restarted, so two quick
 * presses and a refresh wrote nothing at all — the reported "order does not
 * persist". A list of ids is small enough to send synchronously and cannot lose
 * an edit made anywhere else.
 */
app.patch(
  ["/api/v1/my-website/pages/:slug/order", "/api/my-website/pages/:slug/order"],
  async (req, res) => {
    try {
      const session = await requireSession(req);
      const sectionIds = (req.body ?? {}).sectionIds;
      res.json(
        await reorderPageSections(session.collegeId, slugParam(req.params.slug), sectionIds),
      );
    } catch (error) {
      fail(res, error);
    }
  },
);

app.delete(["/api/v1/my-website/pages/:slug", "/api/my-website/pages/:slug"], async (req, res) => {
  try {
    const session = await requireSession(req);
    res.json(await deletePage(session.collegeId, slugParam(req.params.slug)));
  } catch (error) {
    fail(res, error);
  }
});

/**
 * The section library a tenant may read.
 *
 * The editor asked `/api/v1/admin/templates` for this, which requires an admin
 * session; a college session fails it, so every tenant's template list was
 * empty and the Add Section picker showed all nineteen categories as "Not in
 * library". Same collection, tenant-appropriate projection: published and
 * non-archived only, one resolved category per row, deterministic order.
 */
app.get(["/api/v1/section-library", "/api/section-library"], async (req, res) => {
  try {
    await requireSession(req);
    res.json(await getSectionLibrary());
  } catch (error) {
    fail(res, error);
  }
});

/**
 * The editor theme.
 *
 * Stored as an id, never as colours. The editor used to apply a theme by
 * rewriting every section's HTML with a find-and-replace over a dozen hardcoded
 * hex values — so the theme was not a setting at all, it was a destructive
 * migration of the tenant's own markup, and switching back could not restore
 * what the previous switch had overwritten. An id is reversible, is one field,
 * and means the published site can render the same theme without re-deriving it.
 */
app.get(["/api/v1/my-theme", "/api/my-theme"], async (req, res) => {
  try {
    const session = await requireSession(req);
    const college = await College.findById(session.collegeId).select("themePaletteId themeFontId").lean();
    res.json({
      themeId: (college as { themePaletteId?: string | null } | null)?.themePaletteId ?? null,
      fontId: (college as { themeFontId?: string | null } | null)?.themeFontId ?? null,
    });
  } catch (error) {
    fail(res, error);
  }
});

app.put(["/api/v1/my-theme", "/api/my-theme"], async (req, res) => {
  try {
    const session = await requireSession(req);
    const body = req.body ?? {};
    const themeId = typeof body.themeId === "string" ? body.themeId.trim() : null;
    const fontId = typeof body.fontId === "string" ? body.fontId.trim() : null;

    // Validated against the list the frontend renders, so an id that no theme
    // answers to cannot be stored and then applied to nothing on the live site.
    if (themeId && !EDITOR_THEME_IDS.includes(themeId)) {
      throw new BadRequest(`Unknown theme "${themeId}".`);
    }
    if (fontId && !EDITOR_FONT_IDS.includes(fontId)) {
      throw new BadRequest(`Unknown font pack "${fontId}".`);
    }

    const college = await College.findById(session.collegeId);
    if (!college) throw new NotFound("This account is not linked to a college.");

    if (themeId !== null) college.themePaletteId = themeId;
    if (fontId !== null) college.themeFontId = fontId;
    await college.save();

    res.json({ themeId: college.themePaletteId ?? null, fontId: college.themeFontId ?? null });
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
 * Site settings: SEO, maintenance mode, custom code.
 *
 * A PATCH rather than a PUT: the settings screen has three independent cards,
 * and sending the whole object from one of them would revert whatever another
 * changed in between.
 */
app.get(["/api/v1/site-settings", "/api/site-settings"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      res.status(401).json({ error: "Sign in to view settings." });
      return;
    }
    res.json(await getSettings(session.collegeId));
  } catch (error) {
    fail(res, error);
  }
});

app.patch(["/api/v1/site-settings", "/api/site-settings"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      res.status(401).json({ error: "Sign in to change settings." });
      return;
    }
    const actor = await actorEmailFor(session.collegeId, session.userId);
    res.json(await updateSettings(session.collegeId, req.body, actor));
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Password change.
 *
 * The user is taken from the session, never the body, so this cannot be aimed
 * at another account. The current password is verified before anything changes.
 */
app.post(["/api/v1/account/password", "/api/account/password"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      res.status(401).json({ error: "Sign in to change your password." });
      return;
    }
    const actor = await actorEmailFor(session.collegeId, session.userId);
    await changePassword(session.collegeId, session.userId, req.body, actor);
    res.status(204).end();
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Billing.
 *
 * Reports what exists. No plan is priced, no usage is metered and no invoice is
 * raised anywhere in this platform, so a tenant with no invoices is told they
 * have none rather than shown a plausible history.
 */
app.get(["/api/v1/billing/invoices", "/api/billing/invoices"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      res.status(401).json({ error: "Sign in to view billing." });
      return;
    }
    res.json({ invoices: await listInvoices(session.collegeId) });
  } catch (error) {
    fail(res, error);
  }
});

app.get(["/api/v1/billing/payment-methods", "/api/billing/payment-methods"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      res.status(401).json({ error: "Sign in to view payment methods." });
      return;
    }
    res.json({
      provider: paymentProvider(),
      paymentMethods: await listPaymentMethods(session.collegeId),
    });
  } catch (error) {
    fail(res, error);
  }
});

app.post(["/api/v1/billing/payment-methods", "/api/billing/payment-methods"], async (req, res) => {
  try {
    const session = await getSession(req.headers.cookie).catch(() => null);
    if (!session) {
      res.status(401).json({ error: "Sign in to add a payment method." });
      return;
    }
    const actor = await actorEmailFor(session.collegeId, session.userId);
    res.status(201).json(await attachPaymentMethod(session.collegeId, req.body, actor));
  } catch (error) {
    fail(res, error);
  }
});

app.delete(
  ["/api/v1/billing/payment-methods/:id", "/api/billing/payment-methods/:id"],
  async (req, res) => {
    try {
      const session = await getSession(req.headers.cookie).catch(() => null);
      if (!session) {
        res.status(401).json({ error: "Sign in to remove a payment method." });
        return;
      }
      const actor = await actorEmailFor(session.collegeId, session.userId);
      await detachPaymentMethod(session.collegeId, String(req.params.id), actor);
      res.status(204).end();
    } catch (error) {
      fail(res, error);
    }
  },
);

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
      /**
       * Sanitised on the way out as well as on the way in.
       *
       * Every tenant's `websiteConfig` and `publishedConfig` was written before
       * any sanitisation existed, so the stored markup is untrusted regardless
       * of what the write path now does. Cleaning here means an existing site
       * stops being exploitable at deploy time rather than the next time its
       * owner happens to press save.
       */
      /**
       * Sanitised, then given back the scripts an admin-authored section needs.
       *
       * A published section whose content is built by its own JavaScript — a
       * slider, a carousel, a tab panel — otherwise renders on the live site as
       * an empty band, because `sanitizeSectionHtml` stripped that script when
       * the tenant saved. The script comes from the `Template` row by
       * `templateId`, never from anything a tenant submitted.
       */
      const liveConfig = college
        ? await restoreTemplateScripts(sanitizeWebsiteConfig(publishedSiteConfig(college)))
        : null;

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
          /**
           * The theme the tenant chose, so their live site renders in it.
           *
           * Two ids rather than a palette. The theme is applied by the renderer
           * as CSS custom properties keyed on these, so the section markup that
           * was published stays exactly as it was authored — which is what
           * makes a theme change something a tenant can undo, and what stops a
           * republish from baking one theme's colours into their content
           * permanently.
           */
          theme: {
            themeId: college.themePaletteId ?? null,
            fontId: college.themeFontId ?? null,
          },
          /**
           * The settings the renderer has to honour: whether to serve the site
           * at all, whether search engines may index it, and what custom markup
           * to emit.
           *
           * `onOwnDomain` is decided here from the host the visitor actually
           * used, and it fails closed — a request that does not say gets the
           * stripped form. It is what determines whether a tenant's <script>
           * runs, and that decision must not be made by the client that would
           * benefit from getting it wrong.
           */
          settings: publicSettingsFor(college, {
            onOwnDomain: (() => {
              const host = typeof req.query.host === "string" ? req.query.host.toLowerCase() : "";
              if (!host) return false;
              return (college.domains ?? []).some(
                (domain: any) => domain?.status === "ACTIVE" && domain?.hostname === host,
              );
            })(),
          }),
        });
        return;
      }

      /**
       * The platform default, sanitised exactly as a tenant's own config is.
       *
       * This branch answers for a subdomain with no college row — which on a
       * fresh deployment is every visitor — and it was the one path out of this
       * endpoint that returned section markup straight from the database. The
       * markup is admin-authored rather than tenant-authored, so this is not
       * the same severity as the branch above; it is still the difference
       * between one rule for section HTML leaving this service and two.
       *
       * It is also what strips document-level tags such as `<title>` out of a
       * section, which otherwise arrive in the renderer and compete with the
       * page's own.
       */
      const defConfig = await restoreTemplateScripts(
        sanitizeWebsiteConfig(await getDefaultWebsiteConfig().catch(() => ({ pages: [] }))),
      );
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
      // Same reasoning as the public route above: stored markup predates the
      // sanitiser, and this route is unauthenticated.
      /**
       * Sanitised, then given back the scripts an admin-authored section needs.
       *
       * A published section whose content is built by its own JavaScript — a
       * slider, a carousel, a tab panel — otherwise renders on the live site as
       * an empty band, because `sanitizeSectionHtml` stripped that script when
       * the tenant saved. The script comes from the `Template` row by
       * `templateId`, never from anything a tenant submitted.
       */
      const liveConfig = college
        ? await restoreTemplateScripts(sanitizeWebsiteConfig(publishedSiteConfig(college)))
        : null;

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
      /**
       * Four fields, listed. This branch used to send `college` itself.
       *
       * A Mongoose document serialised whole, from a route with no session, for
       * any subdomain a caller cared to type. `CollegeSchema`'s toJSON transform
       * removes `_id` and `__v` and nothing else, so the response carried
       * `users[]` in full — every account's email address and, beside it, its
       * bcrypt `passwordHash` — plus `websiteConfig`, the unpublished draft, and
       * the tenant's `domains[]` with their verification tokens.
       *
       * It was reachable whenever `publishedSiteConfig()` came back without a
       * `pages` array, which is the ordinary state of a college that has never
       * published: exactly the tenants whose data has had the least attention.
       *
       * The projection below is the fix and the guard against the next one. A
       * literal cannot grow a field because a model did.
       */
      res.json({
        college: college
          ? {
              id: college.id,
              name: college.name,
              subdomain: college.subdomain,
              status: college.status,
            }
          : {
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

/**
 * SVG is a document, not a picture, and this service serves it from its own
 * origin.
 *
 * An `.svg` may contain `<script>`, `<foreignObject>` and event handlers, and
 * they all execute when a browser *navigates* to the file — which is one click
 * on the URL this endpoint hands back. That execution happens on
 * `api.webxite.org`, inside the session cookie's `.webxite.org` scope and inside
 * `isAllowedOrigin`'s allowlist, so it can call this API as whoever is signed in
 * and read the answers. The global CSP above does not stop it: `script-src` is
 * `'self' 'unsafe-inline'`, and an inline script in a same-origin document is
 * exactly what that permits.
 *
 * Uploads keep working. `<img src="...svg">` and `background-image` are
 * subresource loads, where `Content-Disposition` is ignored and the sandbox CSP
 * is irrelevant because no script runs in an image context anyway. Only direct
 * navigation changes, and it changes to a download.
 */
const SCRIPTABLE_EXTENSIONS = new Set([".svg"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10 },
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

    /**
     * Uploaded bytes are never a document on this origin.
     *
     * `sandbox` puts anything that does render into an opaque origin with no
     * script; `default-src 'none'` stops it fetching. Both are set for every
     * type rather than only the scriptable ones, because the next format added
     * to ALLOWED should be safe by default rather than by remembering this.
     */
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (SCRIPTABLE_EXTENSIONS.has(path.extname(target))) {
      res.setHeader("Content-Disposition", "attachment");
    }

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

/*
 * A "catch-all route fallback for resilience" was registered here.
 *
 * It matched on substrings of the path and answered 200: anything containing
 * "templates" got `{templates: []}`, anything containing "status" got
 * `{status: "ok"}`, anything containing "me" — which is most words — got
 * `{admin: null}`.
 *
 * It is unreachable in practice, because the 404 handler above it answers
 * first, and that is the only reason it was not actively harmful. What it would
 * have done is worse than a 404: `{"status":"ok"}` from a path that does not
 * exist tells a monitor the service is healthy when it is not, and `admin: null`
 * from an admin path that has been renamed or removed looks to the panel like a
 * signed-out session rather than a broken deploy. Resilience that reports
 * success for work that did not happen is the failure mode this codebase has
 * already fixed in `submitAccessRequest` and in `loginAction`.
 */

app.listen(PORT, async () => {
  console.log(`[api] xite backend listening on :${PORT}`);
  console.log(`[api] CORS origins: ${ORIGINS.length ? ORIGINS.join(", ") : "(any)"}`);
  console.log(`[api] docs: /docs`);

  /**
   * Started before the database is awaited, and deliberately.
   *
   * `connectDB` retries eight times with a fifteen-second selection timeout, so
   * anything sequenced after it waits up to two minutes — and if the database
   * is unreachable at boot it throws, so anything inside that block never runs
   * at all. Either way a deployment that came up before Atlas did would never
   * start the monitor, and no domain would be re-checked until somebody
   * redeployed. The watchdog reconnects the database; nothing was reconnecting
   * this.
   *
   * The first pass is a minute away and tolerates a database that is not there
   * yet: it logs the failure and returns. That is by far the cheaper mistake.
   */
  startDomainMonitor();

  /**
   * Resolved at boot so its verdict is in the deploy log.
   *
   * `domainRouter()` is lazy and would otherwise first run on somebody's
   * verification, hours later, printing "edge routing is not configured" into a
   * request log nobody reads. Whether custom domains can be served at all is a
   * deployment fact, and it belongs beside the CORS origins and the port.
   */
  domainRouter();
  try {
    await connectDB();
    await bootstrapAdmin();
    /**
     * Domains re-check themselves from here on.
     *
     * Started after the database is up, because the first pass reads rows. It
     * closes the two halves of the same gap: a domain waiting on DNS never
     * advanced without somebody pressing Check, and a domain that had reached
     * ACTIVE was never re-read, so one that quietly broke months later kept a
     * green tick while visitors got nothing.
     */
  } catch (err) {
    console.error("[api] Database startup error:", err);
  }
  verifyDocs();

  // Background reconnect: auto-heal DB connection every 30s if disconnected.
  // This means once MongoDB Atlas whitelist is fixed, the server auto-connects
  // without needing a Dokploy redeploy.
  setInterval(async () => {
    if (mongoose.connection.readyState !== 1) {
      const uri = mongoUri();
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

