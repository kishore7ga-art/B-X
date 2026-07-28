import "dotenv/config";

import { randomUUID } from "node:crypto";
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
  getAdminSession,
} from "@/admin-service";
import { bootstrapAdmin } from "@/admin-bootstrap";
import { getSession, readSession } from "@/auth";
import {
  AuthError,
  COOKIE_NAME,
  cookieOptions,
  login,
  mintSessionToken,
  signup,
  signupSchema,
} from "@/auth-service";
import { prisma } from "@/db";
import {
  cycleTemplate,
  getTemplatePreview,
  startWithDesign,
  startWithDesignSchema,
} from "@/design-service";
import { docsPage } from "@/docs-page";
import {
  buildSiteForType,
  completeOnboarding,
  onboardingSchema,
} from "@/onboarding-service";
import { SESSION_RENEW_AFTER_SECONDS } from "@/lib/api-contract";
import { assertFullyDocumented, openApiDocument } from "@/openapi";
import {
  getSitePage,
  getTemplateDetail,
  listTemplates,
} from "@/site-service";
import { getCollege, getEditorPage } from "@/editor-service";
import {
  BadRequest,
  listHistory,
  NotFound,
  restoreSchema,
  restoreVersion,
  saveContent,
  saveSchema,
} from "@/sections-service";

const PORT = Number(process.env.PORT ?? 4000);
const UPLOAD_DIR =
  process.env.UPLOAD_DIR ?? path.join(process.cwd(), "public", "uploads");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

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
 * Only the frontend may call this, and it must be named exactly.
 *
 * `*` is not an option: the session cookie rides on these requests, and
 * browsers refuse a wildcard origin alongside credentials.
 */
const ORIGINS = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: ORIGINS.length ? ORIGINS : true,
    credentials: true,
  }),
);

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

app.get("/api/health", async (_req, res) => {
  const startedAt = Date.now();
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    res.json({
      status: "ok",
      service: "backend",
      database: "connected",
      templates: await prisma.template.count().catch(() => null),
      latencyMs: Date.now() - startedAt,
    });
  } catch (error) {
    // 503 so an uptime monitor notices, with the reason but never the URL.
    console.error("[health] database unreachable:", (error as Error).message);
    res.status(503).json({
      status: "degraded",
      service: "backend",
      database: "unreachable",
    });
  }
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
  /**
   * Account creation. Every call costs a bcrypt hash and writes a user and a
   * college, so this is the CPU-and-junk-rows vector rather than the guessing
   * one. Five an hour is far above what a person needs and far below what a
   * script wants.
   */
  signup: { max: 5, windowMs: 60 * 60 * 1000 },
  /**
   * Guessing an admin password is worth more than guessing a college owner's,
   * and there is no legitimate reason for a person to get this wrong five
   * times in a quarter hour.
   */
  adminLogin: { max: 5, windowMs: 15 * 60 * 1000 },
} as const;

const LONGEST_WINDOW_MS = Math.max(
  ...Object.values(LIMITS).map((limit) => limit.windowMs),
);

const attempts = new Map<string, number[]>();

/**
 * Records an attempt and says whether it was one too many.
 *
 * `req.ip` is only the real client because `trust proxy` is set above; keyed on
 * the socket address it would be one bucket for the whole internet.
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

/** One place, so a new limited route cannot invent a different envelope. */
function rateLimit(action: keyof typeof LIMITS, req: express.Request) {
  return tooManyAttempts(action, req.ip ?? "unknown");
}

app.post("/api/v1/auth/signup", async (req, res) => {
  try {
    if (rateLimit("signup", req)) {
      res
        .status(429)
        .json({ error: "Too many accounts created. Try again later." });
      return;
    }

    const input = signupSchema.parse(req.body);
    res.status(201).json(await signup(input));
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/v1/auth/login", async (req, res) => {
  try {
    if (rateLimit("login", req)) {
      res.status(429).json({ error: "Too many attempts. Try again later." });
      return;
    }

    const { token, subdomain, next } = await login(req.body ?? {});
    res.cookie(COOKIE_NAME, token, cookieOptions(requestHost(req)));
    res.json({ subdomain, next });
  } catch (error) {
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
app.get("/api/v1/templates", async (_req, res) => {
  try {
    res.json({ templates: await listTemplates() });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/v1/templates/:templateId", async (req, res) => {
  try {
    const detail = await getTemplateDetail(req.params.templateId);
    if (!detail) {
      res.status(404).json({ error: "No such template" });
      return;
    }
    res.json(detail);
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/v1/sites/:subdomain", async (req, res) => {
  try {
    // A session is optional here and only ever widens what is visible: without
    // one you see published sites, with one you also see your own draft.
    const session = await getSession(req.headers.cookie);
    const page = typeof req.query.page === "string" ? req.query.page : undefined;

    const data = await getSitePage(
      req.params.subdomain,
      page,
      session?.collegeId ?? null,
    );

    if (!data) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.json(data);
  } catch (error) {
    fail(res, error);
  }
});

// --- Editor reads -------------------------------------------------------------

/**
 * Who the caller is, as far as the guarded pages are concerned.
 *
 * 204 rather than 404 for a session whose college has since been deleted: the
 * request was understood and answered, there simply is no college. A 404 here
 * would be indistinguishable from asking for the wrong URL.
 */
app.get("/api/v1/me", async (req, res) => {
  try {
    const session = await requireSession(req);
    const college = await getCollege(session.collegeId);
    if (!college) {
      res.status(204).end();
      return;
    }
    res.json({ college });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/v1/editor/:subdomain", async (req, res) => {
  try {
    const session = await requireSession(req);
    const page =
      typeof req.query.page === "string" ? req.query.page : undefined;

    const data = await getEditorPage(req.params.subdomain, page);
    if (!data) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // The tenant boundary, enforced where the data is rather than trusted to
    // the caller: a session may only read its own college's editor.
    if (data.college.id !== session.collegeId) {
      res.status(403).json({ error: "Not your college" });
      return;
    }

    res.json(data);
  } catch (error) {
    fail(res, error);
  }
});

// --- Admin panel --------------------------------------------------------------

/**
 * Its own session, its own cookie, its own signing key.
 *
 * `requireSession` above resolves a *college*. This resolves an admin, and the
 * two share nothing — a college cookie presented here verifies against a key it
 * was not signed with and fails, which is the point of them being separate.
 */
async function requireAdmin(req: express.Request) {
  if (!adminConfigured()) {
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
app.post("/api/v1/admin/auth/login", async (req, res) => {
  try {
    if (rateLimit("adminLogin", req)) {
      res.status(429).json({ error: "Too many attempts. Try again later." });
      return;
    }

    const { token, admin } = await adminLogin(req.body ?? {});
    res.cookie(ADMIN_COOKIE_NAME, token, adminCookieOptions());
    res.json({ admin });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/v1/admin/status", async (_req, res) => {
  try {
    res.json(await adminStatus());
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/v1/admin/auth/logout", (_req, res) => {
  const { maxAge: _drop, ...options } = adminCookieOptions();
  res.clearCookie(ADMIN_COOKIE_NAME, options);
  res.json({ ok: true });
});

app.get("/api/v1/admin/me", async (req, res) => {
  try {
    const session = await requireAdmin(req);
    res.json({ admin: session });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/v1/admin/overview", async (req, res) => {
  try {
    await requireAdmin(req);
    res.json(await adminOverview());
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/v1/admin/sites", async (req, res) => {
  try {
    await requireAdmin(req);
    res.json({ sites: await adminSites() });
  } catch (error) {
    fail(res, error);
  }
});

// --- Onboarding and design ----------------------------------------------------

/**
 * Every one of these is a write scoped to the caller's own college.
 *
 * The tenant comes from the session and never from the body — there is no
 * collegeId parameter to tamper with, which is why none of them needs an
 * ownership check beyond being signed in.
 */
app.post("/api/v1/onboarding", async (req, res) => {
  try {
    const session = await requireSession(req);
    const input = onboardingSchema.parse(req.body);
    res.json(await completeOnboarding(session.collegeId, input));
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/v1/onboarding/build", async (req, res) => {
  try {
    const session = await requireSession(req);
    res.json(await buildSiteForType(session.collegeId));
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/v1/design", async (req, res) => {
  try {
    const session = await requireSession(req);
    const input = startWithDesignSchema.parse(req.body);
    res.json(await startWithDesign(session.collegeId, input));
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/v1/design/cycle", async (req, res) => {
  try {
    const session = await requireSession(req);
    res.json(await cycleTemplate(session.collegeId));
  } catch (error) {
    fail(res, error);
  }
});

/**
 * What a template would look like on this college, without writing anything.
 *
 * Behind a session and scoped to the caller's own college: it renders that
 * college's name and theme into the preview, so it is their data even though
 * nothing is saved.
 */
app.get("/api/v1/sites/:subdomain/preview", async (req, res) => {
  try {
    const session = await requireSession(req);
    const templateId =
      typeof req.query.template === "string" ? req.query.template : undefined;
    if (!templateId) {
      res.status(400).json({ error: "template query parameter is required" });
      return;
    }

    const college = await getCollege(session.collegeId);
    if (!college || college.subdomain !== req.params.subdomain) {
      res.status(403).json({ error: "Not your college" });
      return;
    }

    const data = await getTemplatePreview(req.params.subdomain, templateId);
    if (!data) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.json(data);
  } catch (error) {
    fail(res, error);
  }
});

// --- Sections ---------------------------------------------------------------

app.get("/api/v1/sections/:id", async (req, res) => {
  try {
    const session = await requireSession(req);
    res.json({ versions: await listHistory(req.params.id, session.collegeId) });
  } catch (error) {
    fail(res, error);
  }
});

app.patch("/api/v1/sections/:id", async (req, res) => {
  try {
    const session = await requireSession(req);
    const input = saveSchema.parse(req.body);
    res.json(await saveContent(req.params.id, session.collegeId, input));
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/v1/sections/:id", async (req, res) => {
  try {
    const session = await requireSession(req);
    const { versionId } = restoreSchema.parse(req.body);
    res.json(await restoreVersion(req.params.id, session.collegeId, versionId));
  } catch (error) {
    fail(res, error);
  }
});

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
    const path = layer.route?.path;
    if (typeof path !== "string") continue;
    for (const [method, enabled] of Object.entries(layer.route?.methods ?? {})) {
      if (enabled) routes.push({ method: method.toUpperCase(), path });
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

  if (process.env.NODE_ENV === "production") {
    console.error(message);
    return;
  }
  console.error(message);
  throw new Error("Undocumented routes — add them to src/openapi.ts");
}

app.listen(PORT, () => {
  console.log(`[api] xite backend listening on :${PORT}`);
  console.log(`[api] CORS origins: ${ORIGINS.length ? ORIGINS.join(", ") : "(any)"}`);
  console.log(`[api] docs: /docs`);
  // After listen, so a slow database cannot delay the port opening.
  void bootstrapAdmin();
  verifyDocs();
});
