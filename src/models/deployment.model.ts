import mongoose, { Schema, Document } from "mongoose";

/**
 * One row per publish — the history this platform did not have.
 *
 * `College.publishedVersion` is a bare counter. It said a site had been
 * published twenty times and nothing else: not what version nineteen
 * contained, not who pressed the button, not whether anything went wrong, not
 * whether visitors could actually reach it afterwards. "When did this page
 * change and who changed it" had no answer, and neither did "was that publish
 * the one that broke it".
 *
 * ── What this deliberately is not ───────────────────────────────────────────
 *
 * It is not a Vercel deployment, because this platform has no build step. There
 * is no bundler, no artifact and no upload: a tenant's sections are HTML held in
 * Mongo and rendered server-side on each request, and publishing is one atomic
 * field copy. So there is no `Build` collection either — a build row would
 * record nothing that `publishedConfig` does not already hold, and no
 * `BUILDING` or `DEPLOYING` status, because there is no interval during which a
 * site is in one. A status that is written and never observed is the same
 * failure as a status that lies.
 *
 * What it does record is every fact about a publish that was previously
 * unrecoverable, plus the two that matter afterwards: whether it was superseded,
 * and what went wrong if anything did.
 */

export type DeploymentStatus =
  /** The publish completed and this is the version visitors are served. */
  | "LIVE"
  /** Completed, and a later publish has replaced it. */
  | "SUPERSEDED"
  /** Did not complete. `error` says why. Nothing was served from it. */
  | "FAILED";

export interface IDeployment extends Document {
  id: string;
  /** The college. Every query filters on it; nothing joins across tenants. */
  tenantId: string;
  /** Which user pressed the button. Kept even after they are removed. */
  userId?: string | null;
  actorEmail?: string | null;
  /**
   * `College.publishedVersion` at the moment this publish completed.
   *
   * The join key back to the tenant document, and unique per tenant so two
   * concurrent publishes cannot both claim to be version N — the same guard
   * `publishSite` applies to the write itself, enforced a second time by the
   * database rather than by hoping the application got it right.
   */
  version: number;
  status: DeploymentStatus;
  /** What was actually published, for "what changed" without storing the config twice. */
  pages: number;
  sections: number;
  /** Page slugs at publish time, so a removed page is still traceable. */
  pageSlugs: string[];
  /**
   * Where this version is reachable. The tenant's own domain when they have a
   * servable one, else the platform subdomain.
   */
  publishedUrl?: string | null;
  /** "platform" or a custom hostname. Which surface served it. */
  target: string;
  /** Why it failed, in a sentence. Never a stack trace. */
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const DeploymentSchema = new Schema<IDeployment>(
  {
    tenantId: { type: String, required: true, index: true },
    userId: { type: String, default: null },
    actorEmail: { type: String, default: null },
    version: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["LIVE", "SUPERSEDED", "FAILED"],
      required: true,
      index: true,
    },
    pages: { type: Number, default: 0, min: 0 },
    sections: { type: Number, default: 0, min: 0 },
    pageSlugs: { type: [String], default: [] },
    publishedUrl: { type: String, default: null },
    target: { type: String, default: "platform" },
    error: { type: String, default: null, maxlength: 300 },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: Record<string, any>) => {
        ret.id = ret._id ? ret._id.toString() : ret.id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

/** The only listing there is: this tenant's history, newest first. */
DeploymentSchema.index({ tenantId: 1, createdAt: -1 });

/**
 * One deployment per tenant per version.
 *
 * `publishSite` already guards the write with a version check, so two
 * concurrent publishes cannot both advance the counter. This is that same
 * invariant asserted at the database, which is where it survives a refactor of
 * the code above it.
 */
DeploymentSchema.index({ tenantId: 1, version: 1 }, { unique: true });

/**
 * "Which version is live" — one row per tenant, enforced.
 *
 * Partial and unique together: at most one LIVE deployment per tenant, and the
 * many SUPERSEDED and FAILED rows do not collide. Without the partial filter
 * this index would permit exactly one deployment of any kind per tenant, which
 * is the opposite of a history.
 */
DeploymentSchema.index(
  { tenantId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "LIVE" } },
);

export const Deployment =
  mongoose.models.Deployment ||
  mongoose.model<IDeployment>("Deployment", DeploymentSchema);
