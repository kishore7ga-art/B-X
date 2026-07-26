import "dotenv/config";

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import cors from "cors";
import express from "express";
import multer from "multer";

import { getSession } from "@/auth";
import { prisma } from "@/db";
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
    error instanceof NotFound
      ? 404
      : error instanceof Error && error.name === "Unauthorized"
        ? 401
        : 400;
  res.status(status).json({ error: message });
}

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
