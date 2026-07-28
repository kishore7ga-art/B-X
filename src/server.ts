import "dotenv/config";

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import cors from "cors";
import express from "express";
import multer from "multer";

import { getSession } from "@/auth";
import {
  AuthError,
  COOKIE_NAME,
  cookieOptions,
  login,
  signup,
  signupSchema,
} from "@/auth-service";
import { prisma } from "@/db";
import { getCollege, getEditorPage } from "@/editor-service";
import {
  listHistory,
  NotFound,
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

async function requireSession(req: express.Request) {
  const session = await getSession(req.headers.cookie);
  if (!session) {
    const error = new Error("Not signed in");
    error.name = "Unauthorized";
    throw error;
  }
  return session;
}

function fail(res: express.Response, error: unknown) {
  const message = error instanceof Error ? error.message : "Request failed";
  const status =
    error instanceof AuthError
      ? error.status
      : error instanceof NotFound
        ? 404
        : error instanceof Error && error.name === "Unauthorized"
          ? 401
          : 400;
  res.status(status).json({ error: message });
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
 * A crude cap on password guessing.
 *
 * `/api/v1/auth/login` is reachable by anyone on the internet and answers in
 * bcrypt time, which is fast enough to be worth grinding. In-memory is the
 * right size for one instance; a second replica needs this in the database or
 * a shared cache, and this comment is the reminder.
 */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, number[]>();

function tooManyAttempts(key: string) {
  const now = Date.now();
  const recent = (attempts.get(key) ?? []).filter(
    (at) => now - at < ATTEMPT_WINDOW_MS,
  );
  recent.push(now);
  attempts.set(key, recent);

  // Unbounded otherwise: one entry per IP that ever tried, kept forever.
  if (attempts.size > 5000) {
    for (const [ip, times] of attempts) {
      if (!times.some((at) => now - at < ATTEMPT_WINDOW_MS)) attempts.delete(ip);
    }
  }

  return recent.length > MAX_ATTEMPTS;
}

app.post("/api/v1/auth/signup", async (req, res) => {
  try {
    const input = signupSchema.parse(req.body);
    res.status(201).json(await signup(input));
  } catch (error) {
    // Zod's message is the useful half of a validation failure.
    if (error instanceof Error && error.name === "ZodError") {
      const [issue] = JSON.parse(error.message) as { message: string }[];
      res.status(400).json({ error: issue?.message ?? "Check your details" });
      return;
    }
    fail(res, error);
  }
});

app.post("/api/v1/auth/login", async (req, res) => {
  try {
    if (tooManyAttempts(req.ip ?? "unknown")) {
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

app.post("/api/v1/auth/logout", (req, res) => {
  // Same attributes as when it was set, or the browser keeps the original.
  const { maxAge: _drop, ...options } = cookieOptions(requestHost(req));
  res.clearCookie(COOKIE_NAME, options);
  res.json({ ok: true });
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
    const versionId = (req.body as { versionId?: string })?.versionId;
    if (!versionId) {
      res.status(400).json({ error: "versionId required" });
      return;
    }
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

app.listen(PORT, () => {
  console.log(`[api] xite backend listening on :${PORT}`);
  console.log(`[api] CORS origins: ${ORIGINS.length ? ORIGINS.join(", ") : "(any)"}`);
});
