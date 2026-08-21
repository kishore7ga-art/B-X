import { AuditLog, College } from "@/models";
import type { ICollege, IWebsiteConfig } from "@/models/colleges.model";

/**
 * Draft and published, and the one-way door between them.
 *
 * Before this existed there was a single `websiteConfig`: the editor autosaved
 * into it on a two-second debounce and `/api/v1/public/site/:subdomain` read the
 * same field, so a half-typed heading was on the public internet two seconds
 * later. There was no way to work on a site without visitors watching, and the
 * "Publish Site" button in the editor did not call this service or any other —
 * it set a localStorage key and showed a toast.
 *
 * The split is deliberately additive. `websiteConfig` keeps its name and keeps
 * being the draft; `publishedConfig` is new. Nothing had to be migrated, and no
 * tenant went dark at deploy time, because a site that has never been published
 * still serves its draft — see `publishedSiteConfig`.
 */

export type PublishResult = {
  publishedVersion: number;
  publishedAt: Date;
  pages: number;
  sections: number;
};

export type PublishStatus = {
  hasDraft: boolean;
  hasPublished: boolean;
  publishedVersion: number;
  publishedAt: Date | null;
  publishedByEmail: string | null;
  draftUpdatedAt: Date | null;
  /** Whether the draft differs from what visitors are being served. */
  hasUnpublishedChanges: boolean;
  draftPages: number;
  publishedPages: number;
};

/** A config with nothing in it — distinct from a config that is absent. */
function isEmptyConfig(config: IWebsiteConfig | null | undefined): boolean {
  if (!config || !Array.isArray(config.pages) || config.pages.length === 0) return true;
  return config.pages.every((page) => !Array.isArray(page?.sections) || page.sections.length === 0);
}

function countSections(config: IWebsiteConfig | null | undefined): number {
  if (!config || !Array.isArray(config.pages)) return 0;
  return config.pages.reduce(
    (total, page) => total + (Array.isArray(page?.sections) ? page.sections.length : 0),
    0,
  );
}

/**
 * A structural fingerprint of a config, for "are there unpublished changes?".
 *
 * Compares what actually renders — page slugs and each section's id, order and
 * code — rather than the whole document, so a `updatedAt` bump or a reordered
 * key does not present itself to the tenant as a pending change they need to
 * publish.
 */
function configFingerprint(config: IWebsiteConfig | null | undefined): string {
  if (!config || !Array.isArray(config.pages)) return "";
  return JSON.stringify(
    config.pages.map((page) => [
      page?.slug ?? "",
      (Array.isArray(page?.sections) ? page.sections : []).map((section) => [
        section?.id ?? "",
        section?.code ?? "",
      ]),
    ]),
  );
}

/**
 * What a visitor should be served for this college.
 *
 * The fallback is the migration. A tenant who has published gets their
 * published config; a tenant who never has — which, on the day this shipped,
 * was every tenant — gets their draft, exactly as before. The moment they
 * publish once, the fallback stops applying to them forever.
 *
 * Exported because both the public site route and the by-host lookup need to
 * answer this identically. Two copies of this rule is two answers to "what is
 * live", which is the question the whole feature exists to make answerable.
 */
export function publishedSiteConfig(college: {
  publishedVersion?: number;
  publishedConfig?: IWebsiteConfig | null;
  websiteConfig?: IWebsiteConfig | null;
}): IWebsiteConfig | null {
  if ((college.publishedVersion ?? 0) > 0 && college.publishedConfig) {
    return college.publishedConfig;
  }
  return college.websiteConfig ?? null;
}

/**
 * Copies the draft over the published config, atomically.
 *
 * Atomic in the sense that matters here: one `updateOne` with the new config,
 * the new version and the timestamps in a single `$set`, guarded by a filter on
 * the version the caller read. Two publishes racing cannot interleave to leave
 * `publishedConfig` from one and `publishedVersion` from the other — the second
 * matches no document and is retried against the new state.
 *
 * A transaction would be the textbook answer and is not available: Atlas
 * supports them, but this is a single-document update, where a `$set` is
 * already atomic and a session adds a round trip to protect nothing.
 */
export async function publishSite(
  collegeId: string,
  actorEmail: string | null,
): Promise<PublishResult> {
  // Two attempts, not a loop: the guard exists to stop a lost update, and a
  // second publish landing between the read and the write is already unusual.
  // Anything beyond that is contention worth surfacing rather than hiding.
  for (let attempt = 0; attempt < 2; attempt++) {
    const college = (await College.findById(collegeId).lean()) as ICollege | null;
    if (!college) {
      throw Object.assign(new Error("College not found"), { status: 404 });
    }

    const draft = college.websiteConfig;

    // Publishing an empty draft would take a working site down, which is never
    // what the button means. It is refused rather than performed.
    if (isEmptyConfig(draft)) {
      throw Object.assign(
        new Error("There is nothing to publish — add at least one section first."),
        { status: 400 },
      );
    }

    const currentVersion = college.publishedVersion ?? 0;
    const nextVersion = currentVersion + 1;
    const publishedAt = new Date();

    // No version history is kept here on purpose. This document already carries
    // two complete site configs made of raw section HTML; an array of twenty
    // more is a straight line to Mongo's 16MB per-document limit for the
    // largest tenants, which is the worst possible moment to discover it.
    // Rollback belongs in its own collection, and was not asked for.
    const result = await College.updateOne(
      // The version guard. Without it, two publishes started together both read
      // version N and both write N+1, and one tenant's content is silently lost.
      { _id: collegeId, publishedVersion: currentVersion },
      {
        $set: {
          publishedConfig: draft,
          publishedVersion: nextVersion,
          publishedAt,
          publishedByEmail: actorEmail,
        },
      },
    );

    if (result.matchedCount === 0) {
      // Somebody else published between our read and our write. Read again.
      continue;
    }

    await AuditLog.create({
      action: "SITE_PUBLISHED",
      tenantId: collegeId,
      details: {
        version: nextVersion,
        pages: draft?.pages?.length ?? 0,
        sections: countSections(draft),
        actor: actorEmail,
      },
    }).catch(() => null);

    return {
      publishedVersion: nextVersion,
      publishedAt,
      pages: draft?.pages?.length ?? 0,
      sections: countSections(draft),
    };
  }

  throw Object.assign(
    new Error("Another publish is in progress for this site. Try again in a moment."),
    { status: 409 },
  );
}

/** Everything the settings screen needs to describe draft vs published truthfully. */
export async function publishStatus(collegeId: string): Promise<PublishStatus> {
  const college = (await College.findById(collegeId).lean()) as ICollege | null;
  if (!college) {
    throw Object.assign(new Error("College not found"), { status: 404 });
  }

  const draft = college.websiteConfig ?? null;
  const published = college.publishedConfig ?? null;
  const publishedVersion = college.publishedVersion ?? 0;

  return {
    hasDraft: !isEmptyConfig(draft),
    hasPublished: publishedVersion > 0 && !isEmptyConfig(published),
    publishedVersion,
    publishedAt: college.publishedAt ?? null,
    publishedByEmail: college.publishedByEmail ?? null,
    draftUpdatedAt: college.draftUpdatedAt ?? null,
    // Never published is not "no changes" — it is everything outstanding.
    hasUnpublishedChanges:
      publishedVersion === 0
        ? !isEmptyConfig(draft)
        : configFingerprint(draft) !== configFingerprint(published),
    draftPages: draft?.pages?.length ?? 0,
    publishedPages: published?.pages?.length ?? 0,
  };
}

/** Exported for tests: the pure helpers above have all the decision logic in them. */
export const __testing = { isEmptyConfig, countSections, configFingerprint };
