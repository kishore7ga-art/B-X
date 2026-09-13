import { createHash, randomUUID } from "node:crypto";

import { AnalyticsSession, College, PageView, UptimeLog } from "@/models";
import type { ICollege } from "@/models/colleges.model";
import { BadRequest } from "@/errors";

/**
 * Telemetry: taking it in, and answering questions with it.
 *
 * Two halves with opposite threat models.
 *
 * **Ingestion is unauthenticated by necessity.** The tracking script runs in a
 * visitor's browser on a tenant's own site; there is no session to present. So
 * nothing a beacon says about *who it is* is believed — the tenant is resolved
 * from the hostname against the domains this platform already knows, and a
 * hostname nobody has connected is dropped. A beacon cannot name its own
 * tenant, which is the whole of the isolation story on this side.
 *
 * **Reading is authenticated and tenant-scoped.** Every aggregate below filters
 * on a `tenantId` taken from the session, never from a parameter.
 *
 * Nothing here invents a number. Every figure is computed from rows that exist,
 * and where there are no rows the answer is zero or null rather than a
 * plausible-looking default. A dashboard that shows 87% uptime for a site
 * nobody has ever pinged is worse than one that shows nothing.
 */

/** How recently a session must have been active to count as "right now". */
const LIVE_WINDOW_MS = 5 * 60 * 1000;

/**
 * The per-day salt for visitor hashing.
 *
 * An IP address is personal data, and this platform has no use for the address
 * itself — only for "are these two hits the same person today". Hashing with a
 * secret that rotates daily answers that and makes cross-day correlation
 * impossible even for whoever holds the database.
 *
 * Falls back to SESSION_SECRET so a deployment cannot accidentally hash with an
 * empty salt, which would make the hashes a rainbow-table lookup away from the
 * addresses they were meant to protect.
 */
function visitorSalt(): string {
  const base =
    process.env.ANALYTICS_SALT?.trim() || process.env.SESSION_SECRET?.trim() || "";
  const day = new Date().toISOString().slice(0, 10);
  return `${base}:${day}`;
}

function hashVisitor(ip: string, userAgent: string): string {
  return createHash("sha256")
    .update(`${visitorSalt()}:${ip}:${userAgent}`)
    .digest("hex")
    .slice(0, 32);
}

/** Coarse device class. Deliberately not a stored user-agent string. */
export function deviceTypeOf(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  if (!ua) return "unknown";
  if (/bot|crawler|spider|crawling|headless|lighthouse|pingdom/.test(ua)) return "bot";
  if (/ipad|tablet|playbook|silk/.test(ua)) return "tablet";
  if (/mobi|iphone|android|phone/.test(ua)) return "mobile";
  return "desktop";
}

/**
 * A path, reduced to something safe to store and group by.
 *
 * The query string is dropped entirely. It is where password-reset tokens,
 * email addresses and session ids end up, and none of them belong in an
 * analytics row that will be read back by a dashboard and kept for 90 days.
 */
export function normalizePath(input: unknown): string {
  if (typeof input !== "string" || !input) return "/";
  let path = input.trim();
  // Accept a full URL or a bare path; keep only the path component.
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    return "/";
  }
  path = path.split("?")[0] ?? "/";
  path = path.split("#")[0] ?? "/";
  if (!path.startsWith("/")) path = `/${path}`;
  // A trailing slash is the same page; collapsing it stops /about and /about/
  // being two rows in every report.
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path.slice(0, 512) || "/";
}

/** 0–100, whatever the client sent. A client value is a claim, not a fact. */
function clampPercent(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Which tenant a hostname belongs to.
 *
 * The only thing that links a beacon to an account. A hostname that no tenant
 * has connected and verified resolves to nothing and its beacon is dropped —
 * so a site cannot report traffic into somebody else's dashboard by pointing a
 * script at it.
 */
async function tenantForHostname(hostname: string): Promise<string | null> {
  if (!hostname) return null;
  const clean = hostname.trim().toLowerCase();

  const byCustom = (await College.findOne({
    domains: { $elemMatch: { hostname: clean, status: "ACTIVE" } },
  })
    .select("_id")
    .lean()) as { _id: unknown } | null;
  if (byCustom) return String(byCustom._id);

  // A platform subdomain: <sub>.<root>. The tenant is the first label.
  const root = (process.env.ROOT_DOMAIN || "webxite.org").toLowerCase().trim();
  if (clean.endsWith(`.${root}`)) {
    const sub = clean.slice(0, -(root.length + 1));
    if (sub && !sub.includes(".")) {
      const college = (await College.findOne({ subdomain: sub })
        .select("_id")
        .lean()) as { _id: unknown } | null;
      if (college) return String(college._id);
    }
  }

  return null;
}

export type BeaconResult = { accepted: boolean; sessionId: string | null };

/**
 * Takes one beacon from the tracking script.
 *
 * Returns `accepted: false` rather than throwing for an unknown hostname. The
 * caller answers 204 either way: a tracking script must never learn which
 * hostnames this platform serves, and must never retry into a loop because a
 * site was disconnected.
 */
export async function ingest(input: {
  body: unknown;
  ip: string;
  userAgent: string;
  countryCode?: string | null;
}): Promise<BeaconResult> {
  const body = (input.body ?? {}) as Record<string, unknown>;

  const hostname = typeof body.h === "string" ? body.h.trim().toLowerCase() : "";
  const tenantId = await tenantForHostname(hostname);
  if (!tenantId) return { accepted: false, sessionId: null };

  const device = deviceTypeOf(input.userAgent);
  /*
   * Bots are resolved and then dropped. Counting them would make every figure
   * on the dashboard wrong in the same direction — a site with no visitors and
   * an attentive crawler would report steady traffic and a 100% scroll depth.
   */
  if (device === "bot") return { accepted: false, sessionId: null };

  const visitorHash = hashVisitor(input.ip, input.userAgent);
  const now = new Date();

  /*
   * The session id is only ever trusted to *continue* a session that already
   * belongs to this visitor and tenant. A client-supplied id that matches
   * nothing starts a new session rather than creating a row under an id the
   * client chose — otherwise a beacon could write into another tenant's
   * session by guessing one.
   */
  const claimed = typeof body.s === "string" ? body.s : "";
  let session = claimed
    ? await AnalyticsSession.findOne({ _id: claimed, tenantId, visitorHash })
    : null;

  if (!session) {
    session = await AnalyticsSession.create({
      _id: randomUUID(),
      tenantId,
      hostname,
      visitorHash,
      deviceType: device,
      countryCode: input.countryCode ?? null,
      startedAt: now,
      lastActiveAt: now,
      viewCount: 0,
    });
  }

  const sessionId = String(session._id);
  const path = normalizePath(body.p);
  const scroll = clampPercent(body.d);
  const visible = Math.max(0, Math.min(86_400, Number(body.t) || 0));

  /*
   * One row per (session, path), updated in place. The script sends a beacon at
   * each scroll milestone and again on unload, so a naive insert would produce
   * five rows for one page view and quintuple every traffic figure.
   *
   * `$max` on the depth is what makes it monotonic: a late beacon reporting 25%
   * after an earlier one reported 90% must not erase the 90%. Out-of-order
   * delivery is normal with `sendBeacon`.
   */
  await PageView.findOneAndUpdate(
    { tenantId, sessionId, path },
    {
      $max: { maxScrollPercent: scroll, visibleSeconds: visible },
      $setOnInsert: { hostname, createdAt: now },
    },
    { upsert: true, new: true },
  );

  const views = await PageView.countDocuments({ tenantId, sessionId });
  await AnalyticsSession.updateOne(
    { _id: sessionId },
    { $set: { lastActiveAt: now, viewCount: views } },
  );

  return { accepted: true, sessionId };
}

/* ── Reading ───────────────────────────────────────────────────────────────── */

export type Kpis = {
  activeNow: number;
  uniqueVisitors24h: number;
  uniqueVisitors7d: number;
  pageViews24h: number;
  /** Null when nothing has been measured — never a stand-in number. */
  avgScrollPercent: number | null;
  uptimePercent: number | null;
  avgLatencyMs: number | null;
  checksRecorded: number;
};

export type TrafficPoint = { at: string; views: number; sessions: number };
export type ScrollBucket = { label: string; reached: number; percent: number };

export type AnalyticsOverview = {
  kpis: Kpis;
  traffic: TrafficPoint[];
  scrollFunnel: ScrollBucket[];
  topPaths: { path: string; views: number; avgScrollPercent: number }[];
  hostnames: string[];
  /** When the tenant's site first went live, from the earliest uptime check. */
  firstSeenAt: string | null;
  /** True when no telemetry exists at all, so the UI can explain rather than show zeros. */
  empty: boolean;
};

/** Every hostname this tenant is served on. */
async function hostnamesFor(collegeId: string): Promise<string[]> {
  const college = (await College.findById(collegeId)
    .select("subdomain domains")
    .lean()) as ICollege | null;
  if (!college) return [];

  const root = (process.env.ROOT_DOMAIN || "webxite.org").toLowerCase().trim();
  const names = new Set<string>();
  if (college.subdomain) names.add(`${college.subdomain}.${root}`);
  for (const d of college.domains ?? []) {
    if (d.status === "ACTIVE") names.add(d.hostname);
  }
  return [...names];
}

/**
 * Traffic bucketed by hour over a window.
 *
 * Aggregated in the database rather than by reading rows into the process: a
 * busy tenant over seven days is hundreds of thousands of documents, and
 * counting them in JavaScript is how an analytics page becomes the slowest
 * request in the product.
 */
async function trafficSeries(tenantId: string, hours: number): Promise<TrafficPoint[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const rows = (await PageView.aggregate([
    { $match: { tenantId, createdAt: { $gte: since } } },
    {
      $group: {
        _id: {
          $dateTrunc: { date: "$createdAt", unit: "hour" },
        },
        views: { $sum: 1 },
        sessions: { $addToSet: "$sessionId" },
      },
    },
    { $project: { at: "$_id", views: 1, sessions: { $size: "$sessions" } } },
    { $sort: { at: 1 } },
  ])) as { at: Date; views: number; sessions: number }[];

  return rows.map((r) => ({
    at: new Date(r.at).toISOString(),
    views: r.views,
    sessions: r.sessions,
  }));
}

/**
 * How far down the page people actually get.
 *
 * Cumulative, not exclusive: somebody who reached the footer also reached the
 * header. An exclusive breakdown reads as though most visitors stopped at the
 * top even when most reached the bottom, because each is counted only in its
 * deepest bucket.
 */
async function scrollFunnel(tenantId: string, hours: number): Promise<ScrollBucket[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const total = await PageView.countDocuments({ tenantId, createdAt: { $gte: since } });

  const thresholds: { label: string; min: number }[] = [
    { label: "Past the header", min: 25 },
    { label: "Halfway", min: 50 },
    { label: "Three quarters", min: 75 },
    { label: "Reached the footer", min: 100 },
  ];

  const buckets: ScrollBucket[] = [];
  for (const t of thresholds) {
    const reached = total
      ? await PageView.countDocuments({
          tenantId,
          createdAt: { $gte: since },
          maxScrollPercent: { $gte: t.min },
        })
      : 0;
    buckets.push({
      label: t.label,
      reached,
      percent: total ? Math.round((reached / total) * 100) : 0,
    });
  }
  return buckets;
}

/** Everything the dashboard shows, computed from rows that exist. */
export async function overview(collegeId: string): Promise<AnalyticsOverview> {
  const tenantId = collegeId;
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000);
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const liveSince = new Date(now - LIVE_WINDOW_MS);

  const [
    activeNow,
    unique24h,
    unique7d,
    pageViews24h,
    scrollAgg,
    uptimeAgg,
    traffic,
    funnel,
    topPathsAgg,
    hostnames,
    firstCheck,
  ] = await Promise.all([
    AnalyticsSession.countDocuments({ tenantId, lastActiveAt: { $gte: liveSince } }),
    AnalyticsSession.distinct("visitorHash", { tenantId, startedAt: { $gte: since24h } }),
    AnalyticsSession.distinct("visitorHash", { tenantId, startedAt: { $gte: since7d } }),
    PageView.countDocuments({ tenantId, createdAt: { $gte: since24h } }),
    PageView.aggregate([
      { $match: { tenantId, createdAt: { $gte: since7d } } },
      { $group: { _id: null, avg: { $avg: "$maxScrollPercent" } } },
    ]),
    UptimeLog.aggregate([
      { $match: { tenantId, checkedAt: { $gte: since7d } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          up: { $sum: { $cond: ["$up", 1, 0] } },
          avgLatency: { $avg: "$latencyMs" },
        },
      },
    ]),
    trafficSeries(tenantId, 24),
    scrollFunnel(tenantId, 7 * 24),
    PageView.aggregate([
      { $match: { tenantId, createdAt: { $gte: since7d } } },
      {
        $group: {
          _id: "$path",
          views: { $sum: 1 },
          avgScroll: { $avg: "$maxScrollPercent" },
        },
      },
      { $sort: { views: -1 } },
      { $limit: 8 },
    ]),
    hostnamesFor(collegeId),
    UptimeLog.findOne({ tenantId }).sort({ checkedAt: 1 }).select("checkedAt").lean(),
  ]);

  const uptime = (uptimeAgg as { total: number; up: number; avgLatency: number }[])[0];
  const scroll = (scrollAgg as { avg: number }[])[0];

  const kpis: Kpis = {
    activeNow,
    uniqueVisitors24h: (unique24h as string[]).length,
    uniqueVisitors7d: (unique7d as string[]).length,
    pageViews24h,
    // Null, not 0, when nothing was measured. Zero is a measurement.
    avgScrollPercent: scroll?.avg != null ? Math.round(scroll.avg) : null,
    uptimePercent:
      uptime && uptime.total > 0
        ? Math.round((uptime.up / uptime.total) * 1000) / 10
        : null,
    avgLatencyMs: uptime?.avgLatency != null ? Math.round(uptime.avgLatency) : null,
    checksRecorded: uptime?.total ?? 0,
  };

  const topPaths = (topPathsAgg as { _id: string; views: number; avgScroll: number }[]).map(
    (r) => ({
      path: r._id,
      views: r.views,
      avgScrollPercent: Math.round(r.avgScroll ?? 0),
    }),
  );

  return {
    kpis,
    traffic,
    scrollFunnel: funnel,
    topPaths,
    hostnames,
    firstSeenAt: (firstCheck as { checkedAt?: Date } | null)?.checkedAt?.toISOString() ?? null,
    empty: pageViews24h === 0 && kpis.uniqueVisitors7d === 0 && kpis.checksRecorded === 0,
  };
}

/** Records one uptime observation. Called by the domain monitor, not by a route. */
export async function recordUptime(input: {
  tenantId: string;
  hostname: string;
  latencyMs: number | null;
  httpStatus: number | null;
  sslValid: boolean;
  error?: string | null;
}): Promise<void> {
  await UptimeLog.create({
    tenantId: input.tenantId,
    hostname: input.hostname,
    latencyMs: input.latencyMs,
    httpStatus: input.httpStatus,
    sslValid: input.sslValid,
    // "Up" is any answer at all in the 2xx/3xx range. A 404 from a server that
    // responded is a routing problem, not an outage, and conflating the two
    // makes the uptime figure useless for the thing it is meant to warn about.
    up: input.httpStatus != null && input.httpStatus >= 200 && input.httpStatus < 400,
    error: input.error ?? null,
    checkedAt: new Date(),
  });
}

/** Validates the beacon envelope before anything touches the database. */
export function assertBeaconShape(body: unknown): void {
  if (!body || typeof body !== "object") {
    throw new BadRequest("A telemetry beacon must be a JSON object.");
  }
  const h = (body as Record<string, unknown>).h;
  if (typeof h !== "string" || !h || h.length > 253) {
    throw new BadRequest("A telemetry beacon must name its hostname.");
  }
}

export const __testing = { normalizePath, deviceTypeOf, clampPercent, hashVisitor };
