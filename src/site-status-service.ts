import { College, Deployment } from "@/models";
import type { ICollege } from "@/models/colleges.model";
import type { DeploymentStatus, IDeployment } from "@/models/deployment.model";

/**
 * "Is this site actually live, and if not, why not?"
 *
 * One place that answers it, because it was answered in four with four
 * different rules: the publish tab looked at `publishedVersion`, the domain tab
 * at each domain's `stage`, the renderer at `maintenance.enabled`, and the
 * account screen at nothing at all. A tenant could see "Published", four green
 * ticks and a verified domain while every visitor got a maintenance page, and
 * no screen was wrong — each was reporting its own fragment truthfully.
 *
 * ── Status is derived, never stored ─────────────────────────────────────────
 *
 * This is the whole design. A stored `status: "LIVE"` column is a claim that
 * has to be kept in step with five other facts by every code path that touches
 * any of them, and the first one that forgets leaves a row saying LIVE for a
 * site nobody can reach. That is precisely the failure this is meant to
 * prevent, so the status is computed from the facts on every read. It cannot
 * drift because there is nothing to drift from.
 *
 * The cost is a few indexed reads per call. That is the right trade for a
 * figure whose entire value is being true.
 */

/**
 * The states a website can be in here.
 *
 * Deliberately missing `BUILDING`, `BUILT` and `DEPLOYING`. This platform has
 * no build step — sections are HTML in Mongo, rendered per request, and
 * publishing is one atomic field copy — so there is no interval during which a
 * site is in any of them. Writing a status nobody ever observes is the same
 * class of mistake as writing one that is false.
 */
export type SiteStatus =
  /** Never published. Visitors get nothing of the tenant's. */
  | "DRAFT"
  /** Published and reachable. */
  | "LIVE"
  /** Published, but the tenant has switched maintenance mode on. */
  | "PAUSED"
  /** Published, and the last publish recorded a failure. */
  | "FAILED";

/** One of the six things a publish has to be true for, and whether it is. */
export type Precondition = {
  key: "ownership" | "build" | "deployment" | "linkage" | "domain" | "serving";
  label: string;
  ok: boolean;
  /** Why not, when not. Null when it passed. */
  detail: string | null;
};

export type SiteStatusView = {
  status: SiteStatus;
  /** True only when every precondition below passes. */
  isLive: boolean;
  /** The address a visitor should use, or null when there is not one yet. */
  liveUrl: string | null;
  publishedVersion: number;
  publishedAt: Date | null;
  /** Set when the draft has diverged from what is being served. */
  hasUnpublishedChanges: boolean;
  preconditions: Precondition[];
  /** The current deployment, and the last few before it. */
  deployment: DeploymentView | null;
  history: DeploymentView[];
};

export type DeploymentView = {
  id: string;
  version: number;
  status: DeploymentStatus;
  pages: number;
  sections: number;
  publishedUrl: string | null;
  target: string;
  actorEmail: string | null;
  error: string | null;
  createdAt: Date;
};

function toView(row: IDeployment): DeploymentView {
  return {
    id: String(row._id),
    version: row.version,
    status: row.status,
    pages: row.pages,
    sections: row.sections,
    publishedUrl: row.publishedUrl ?? null,
    target: row.target,
    actorEmail: row.actorEmail ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt,
  };
}

/** Statuses at which a domain is served. Mirrors domain-service. */
const SERVABLE = new Set(["ACTIVE", "VERIFIED"]);

/**
 * The address visitors should use.
 *
 * A servable custom domain wins — it is the one the tenant chose and the one
 * they will put on a prospectus. The platform subdomain is the fallback and is
 * always present, so this only returns null for a tenant with no subdomain,
 * which cannot happen through signup.
 */
export function liveUrlFor(college: {
  subdomain?: string;
  domains?: { hostname?: string; status?: string; isPrimary?: boolean }[] | null;
}): { url: string | null; target: string } {
  const servable = (college.domains ?? []).filter(
    (d) => d.hostname && SERVABLE.has(String(d.status)),
  );
  // A primary domain if one is marked, else the first servable one — the same
  // order the domains screen lists them in.
  const chosen = servable.find((d) => d.isPrimary) ?? servable[0];
  if (chosen?.hostname) {
    return { url: `https://${chosen.hostname}`, target: chosen.hostname };
  }

  const root = (process.env.ROOT_DOMAIN || "webxite.org").toLowerCase().trim();
  if (college.subdomain) {
    return { url: `https://${college.subdomain}.${root}`, target: "platform" };
  }
  return { url: null, target: "platform" };
}

function pageCount(config: unknown): number {
  const pages = (config as { pages?: unknown[] } | null)?.pages;
  return Array.isArray(pages) ? pages.length : 0;
}

function sectionCount(config: unknown): number {
  const pages = (config as { pages?: { sections?: unknown[] }[] } | null)?.pages;
  if (!Array.isArray(pages)) return 0;
  return pages.reduce(
    (total, page) => total + (Array.isArray(page?.sections) ? page.sections.length : 0),
    0,
  );
}

/**
 * The six conditions a publish has to satisfy, each answered from real state.
 *
 * Returned as a list rather than collapsed into a boolean so a screen can say
 * *which* one is outstanding. "Not live" with no reason is the message that
 * sends somebody to re-check DNS they already got right.
 */
function preconditionsFor(
  college: ICollege,
  userId: string,
  live: IDeployment | null,
): Precondition[] {
  const published = college.publishedConfig;
  const publishedVersion = college.publishedVersion ?? 0;
  const maintenance = Boolean(college.settings?.maintenance?.enabled);
  const domains = college.domains ?? [];
  const servable = domains.filter((d) => SERVABLE.has(String(d.status)));

  const ownsIt = (college.users ?? []).some((u) => u.id === userId);

  return [
    {
      key: "ownership",
      label: "You own this website",
      ok: ownsIt,
      detail: ownsIt ? null : "This site belongs to a different account.",
    },
    {
      key: "build",
      label: "A published version exists",
      ok: publishedVersion > 0 && sectionCount(published) > 0,
      detail:
        publishedVersion === 0
          ? "Nothing has been published yet."
          : sectionCount(published) === 0
            ? "The published version has no sections in it."
            : null,
    },
    {
      key: "deployment",
      label: "The last publish completed",
      ok: live !== null,
      detail:
        live === null
          ? publishedVersion > 0
            ? "Published before publish history was recorded, so there is no record to check."
            : "No publish has been recorded."
          : null,
    },
    {
      key: "linkage",
      label: "The live version matches the published one",
      /*
       * The consistency check that catches the state this whole file exists to
       * make impossible: a deployment row saying LIVE for a version the tenant
       * document no longer serves. It happens if a publish half-completes.
       */
      ok: live === null ? publishedVersion === 0 : live.version === publishedVersion,
      detail:
        live && live.version !== publishedVersion
          ? `The site is serving version ${publishedVersion} but the latest recorded publish is version ${live.version}.`
          : null,
    },
    {
      key: "domain",
      label: domains.length > 0 ? "Your domain is connected" : "Using your WebXite address",
      // No custom domain is not a failure. The platform subdomain always works.
      ok: domains.length === 0 || servable.length > 0,
      detail:
        domains.length > 0 && servable.length === 0
          ? "No connected domain has passed verification yet, so visitors must use your WebXite address."
          : null,
    },
    {
      key: "serving",
      label: "Visitors can see the site",
      ok: !maintenance,
      detail: maintenance
        ? "Maintenance mode is on, so every visitor sees the maintenance page instead of your site."
        : null,
    },
  ];
}

/** DRAFT / LIVE / PAUSED / FAILED, from the facts and nothing else. */
function statusFrom(
  college: ICollege,
  live: IDeployment | null,
  lastFailed: boolean,
): SiteStatus {
  if ((college.publishedVersion ?? 0) === 0) return "DRAFT";
  if (lastFailed && !live) return "FAILED";
  if (college.settings?.maintenance?.enabled) return "PAUSED";
  return "LIVE";
}

/**
 * Everything about whether this site is live, for one tenant.
 *
 * `userId` is the caller's, from the session — the ownership precondition is
 * checked against it rather than assumed, so this doubles as the access check.
 */
export async function siteStatus(
  collegeId: string,
  userId: string,
): Promise<SiteStatusView> {
  const college = (await College.findById(collegeId)) as ICollege | null;
  if (!college) throw Object.assign(new Error("College not found"), { status: 404 });

  const [live, history] = await Promise.all([
    Deployment.findOne({ tenantId: collegeId, status: "LIVE" }) as Promise<IDeployment | null>,
    Deployment.find({ tenantId: collegeId })
      .sort({ createdAt: -1 })
      .limit(10) as unknown as Promise<IDeployment[]>,
  ]);

  const lastFailed = history[0]?.status === "FAILED";
  const preconditions = preconditionsFor(college, userId, live);
  const { url } = liveUrlFor(college);

  const status = statusFrom(college, live, lastFailed);
  const isLive = status === "LIVE" && preconditions.every((p) => p.ok);

  return {
    status,
    isLive,
    // No address is offered unless the site is actually being served on it.
    // A link labelled "your site" that opens a maintenance page is the same
    // lie in a smaller font.
    liveUrl: isLive ? url : null,
    publishedVersion: college.publishedVersion ?? 0,
    publishedAt: college.publishedAt ?? null,
    hasUnpublishedChanges:
      pageCount(college.websiteConfig) > 0 &&
      sectionCount(college.websiteConfig) !== sectionCount(college.publishedConfig),
    preconditions,
    deployment: live ? toView(live) : null,
    history: history.map(toView),
  };
}

/**
 * Records a completed publish, and demotes the one it replaced.
 *
 * Ordered so the unique partial index on LIVE cannot be violated: the previous
 * LIVE row is demoted first, then the new one is inserted. The reverse order
 * would leave two rows claiming LIVE for one tenant, which the index refuses —
 * turning a successful publish into an error after the site had already
 * changed.
 */
export async function recordDeployment(input: {
  tenantId: string;
  userId: string | null;
  actorEmail: string | null;
  version: number;
  config: unknown;
  college: {
    subdomain?: string;
    domains?: { hostname?: string; status?: string; isPrimary?: boolean }[] | null;
  };
}): Promise<void> {
  const { url, target } = liveUrlFor(input.college);
  const pages = (input.config as { pages?: { slug?: string }[] } | null)?.pages ?? [];

  await Deployment.updateMany(
    { tenantId: input.tenantId, status: "LIVE" },
    { $set: { status: "SUPERSEDED" } },
  );

  await Deployment.create({
    tenantId: input.tenantId,
    userId: input.userId,
    actorEmail: input.actorEmail,
    version: input.version,
    status: "LIVE",
    pages: pages.length,
    sections: sectionCount(input.config),
    pageSlugs: pages.map((p) => p?.slug ?? "").filter(Boolean),
    publishedUrl: url,
    target,
  });
}

/**
 * Records a publish that did not complete.
 *
 * Written with the version it was attempting, so a tenant asking "why is my
 * site still on version nineteen" has an answer. `FAILED` is outside the
 * partial index, so recording one never disturbs whichever version is live.
 */
export async function recordFailure(input: {
  tenantId: string;
  userId: string | null;
  actorEmail: string | null;
  version: number;
  error: string;
}): Promise<void> {
  await Deployment.create({
    tenantId: input.tenantId,
    userId: input.userId,
    actorEmail: input.actorEmail,
    version: input.version,
    status: "FAILED",
    // Truncated, and never a stack trace: this is read back by a tenant.
    error: input.error.slice(0, 300),
  }).catch(() => null);
}

export const __testing = { statusFrom, preconditionsFor, sectionCount };
