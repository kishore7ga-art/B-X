import mongoose, { Schema, Document } from "mongoose";

/**
 * Telemetry for published tenant sites.
 *
 * Three collections, all scoped by `tenantId` — the college id. There is
 * deliberately no `users` or `domains` collection here, though the brief asked
 * for both: this platform already has them, as `College.users[]` and
 * `College.domains[]`. A second pair would be a second answer to "who owns this
 * hostname", and the two would disagree the first time a domain was moved or a
 * tenant disabled. Every query below filters on the tenant, and nothing joins
 * across one.
 *
 * ── Why raw rows rather than counters ────────────────────────────────────────
 *
 * A page view is a row. It would be cheaper to increment a per-day counter, and
 * it would also be irreversible: the first time somebody asks "what were the
 * scroll depths on the pricing page last Tuesday" the answer would be gone.
 * Rows are kept for a bounded window and aggregated on read.
 *
 * ── Why everything expires ──────────────────────────────────────────────────
 *
 * Analytics data grows without limit and is worth progressively less. Each
 * collection carries a TTL index so the database cannot become the reason a
 * deployment falls over, and so a tenant who leaves stops costing storage
 * forever. The windows are different because the questions are: sessions and
 * views answer "what happened recently", uptime answers "has this been reliable
 * over months".
 */

/* ── Sessions ──────────────────────────────────────────────────────────────── */

export interface IAnalyticsSession extends Document {
  id: string;
  /** The college whose site this visit was to. Every query filters on it. */
  tenantId: string;
  /** Which of the tenant's hostnames was visited. */
  hostname: string;
  /**
   * A salted hash of the visitor's IP, never the address.
   *
   * An IP address is personal data under GDPR and most equivalents, and this
   * platform has no need for it: the only questions asked are "how many
   * distinct people" and "are these two hits the same person", both of which a
   * hash answers. The salt is per-deployment and per-day, so the same visitor
   * is one person within a day and is not trackable across them.
   */
  visitorHash: string;
  /** Coarse: "desktop", "mobile", "tablet", "bot". Not a full user-agent string. */
  deviceType: string;
  /** Two-letter code where a CDN supplied one, else null. Never derived from IP here. */
  countryCode?: string | null;
  startedAt: Date;
  lastActiveAt: Date;
  /** How many views this session has produced, for an average without a join. */
  viewCount: number;
}

const AnalyticsSessionSchema = new Schema<IAnalyticsSession>({
  tenantId: { type: String, required: true, index: true },
  hostname: { type: String, required: true, trim: true, lowercase: true },
  visitorHash: { type: String, required: true },
  deviceType: { type: String, required: true, default: "unknown" },
  countryCode: { type: String, default: null, uppercase: true, maxlength: 2 },
  startedAt: { type: Date, required: true, default: Date.now },
  lastActiveAt: { type: Date, required: true, default: Date.now, index: true },
  viewCount: { type: Number, default: 0, min: 0 },
});

/** "Active right now" and "unique visitors in the last 24h" — the two hot reads. */
AnalyticsSessionSchema.index({ tenantId: 1, lastActiveAt: -1 });
AnalyticsSessionSchema.index({ tenantId: 1, visitorHash: 1, startedAt: -1 });
/** 90 days. Long enough for a quarter-on-quarter comparison. */
AnalyticsSessionSchema.index({ startedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

/* ── Page views ────────────────────────────────────────────────────────────── */

export interface IPageView extends Document {
  id: string;
  tenantId: string;
  sessionId: string;
  hostname: string;
  /** Path only — no query string, which is where tokens and emails end up. */
  path: string;
  /**
   * Furthest point reached, 0–100.
   *
   * Monotonic within a view: a visitor who reaches 80% and scrolls back up has
   * still seen 80%. Stored as the maximum rather than a series of milestones,
   * because the funnel question — "what share got past the header / to the
   * middle / to the footer" — is answerable from a maximum and the series is
   * ten times the rows for no extra answer.
   */
  maxScrollPercent: number;
  /** Seconds the page was actually visible, excluding backgrounded tabs. */
  visibleSeconds: number;
  createdAt: Date;
}

const PageViewSchema = new Schema<IPageView>({
  tenantId: { type: String, required: true, index: true },
  sessionId: { type: String, required: true, index: true },
  hostname: { type: String, required: true, trim: true, lowercase: true },
  path: { type: String, required: true, trim: true, maxlength: 512 },
  maxScrollPercent: { type: Number, required: true, default: 0, min: 0, max: 100 },
  visibleSeconds: { type: Number, default: 0, min: 0 },
  createdAt: { type: Date, required: true, default: Date.now },
});

/** Traffic over time, and the scroll funnel. Both are tenant + time range. */
PageViewSchema.index({ tenantId: 1, createdAt: -1 });
PageViewSchema.index({ tenantId: 1, path: 1, createdAt: -1 });
PageViewSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

/* ── Uptime ────────────────────────────────────────────────────────────────── */

export interface IUptimeLog extends Document {
  id: string;
  tenantId: string;
  hostname: string;
  /** Round trip in milliseconds, or null when the request never completed. */
  latencyMs?: number | null;
  /** The status the origin actually returned, or null on a transport failure. */
  httpStatus?: number | null;
  sslValid: boolean;
  /** Derived once here so no read has to restate what "up" means. */
  up: boolean;
  /** Why it was down, when it was. Never a stack trace. */
  error?: string | null;
  checkedAt: Date;
}

const UptimeLogSchema = new Schema<IUptimeLog>({
  tenantId: { type: String, required: true, index: true },
  hostname: { type: String, required: true, trim: true, lowercase: true },
  latencyMs: { type: Number, default: null, min: 0 },
  httpStatus: { type: Number, default: null },
  sslValid: { type: Boolean, default: false },
  up: { type: Boolean, required: true, index: true },
  error: { type: String, default: null, maxlength: 300 },
  checkedAt: { type: Date, required: true, default: Date.now },
});

/** Uptime percentage over a window, per hostname. */
UptimeLogSchema.index({ tenantId: 1, hostname: 1, checkedAt: -1 });
/**
 * A year. Uptime is the one figure here worth keeping long: "99.9% over the
 * last twelve months" is a claim somebody may need to substantiate, and it
 * cannot be reconstructed once the rows are gone.
 */
UptimeLogSchema.index({ checkedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 });

export const AnalyticsSession =
  mongoose.models.AnalyticsSession ||
  mongoose.model<IAnalyticsSession>("AnalyticsSession", AnalyticsSessionSchema);
export const PageView =
  mongoose.models.PageView || mongoose.model<IPageView>("PageView", PageViewSchema);
export const UptimeLog =
  mongoose.models.UptimeLog || mongoose.model<IUptimeLog>("UptimeLog", UptimeLogSchema);
