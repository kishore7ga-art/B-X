import mongoose, { Schema, Document } from "mongoose";

export interface ICollegeUser {
  id: string;
  email: string;
  passwordHash: string;
  status: "ACTIVE" | "DISABLED";
  createdAt: Date;
}

export interface ISectionItem {
  id: string;
  title?: string;
  sectionType?: string;
  category?: string;
  code?: string;
  sortOrder?: number;
  /** Which library template this section shows; the variant cycle's identity. */
  templateId?: string | null;
  variantIndex?: number;
  [key: string]: any;
}

export interface IPageItem {
  slug: string;
  title: string;
  sections: ISectionItem[];
}

export interface IWebsiteConfig {
  pages: IPageItem[];
}

/**
 * Where a custom domain is in its lifecycle.
 *
 * These describe observed reality, never intent. `ACTIVE` means this service
 * has seen the domain resolve to us *and* seen TLS terminate on it — not that
 * somebody pressed a button.
 */
export type DomainStatus =
  | "PENDING_VERIFICATION"
  | "VERIFIED"
  | "ACTIVE"
  | "FAILED"
  | "DISCONNECTED";

/**
 * Certificate state.
 *
 * Traefik issues certificates; this service does not. So every value here is
 * the result of a check against the live host, and there is deliberately no way
 * to set it from a request body — a tenant told "SSL: Active" when no
 * certificate exists is worse off than a tenant told nothing.
 */
export type SslStatus = "NONE" | "PENDING" | "ACTIVE" | "ERROR";

export interface ISiteSettings {
  seo: {
    /** When false, the published site emits `noindex, nofollow`. */
    indexingEnabled: boolean;
    title?: string | null;
    description?: string | null;
  };
  maintenance: {
    /** When true, visitors get the maintenance page instead of the site. */
    enabled: boolean;
    message?: string | null;
  };
  customCode: {
    /** Injected into <head> of the published site only. */
    headHtml?: string | null;
    /** Injected immediately before </body> of the published site only. */
    bodyEndHtml?: string | null;
  };
  updatedAt?: Date | null;
}

/**
 * Which of the four checks a domain is currently waiting on.
 *
 * `status` says how far along a domain is; this says *what is outstanding*, and
 * they are not the same question. Three quite different situations all sit at
 * `VERIFIED` — the records do not point here yet, the edge has not been told to
 * serve the host, or the certificate has not been issued — and a tenant looking
 * at the screen needs to know which one they are in, because only the first is
 * theirs to fix.
 *
 * It was derivable from `lastError` by reading the sentence. That is not a
 * thing a UI can do, so the tenant page showed one line of prose and left them
 * to work out whether they were being asked to act or to wait.
 *
 * `done` means all four passed.
 */
export type DomainStage = "ownership" | "routing" | "edge" | "tls" | "done";

export interface ICustomDomain {
  id: string;
  /** Normalised: lowercase, trimmed, no scheme, no port, no trailing dot. */
  hostname: string;
  status: DomainStatus;
  /** The value the tenant puts in their `_xite-verify` TXT record. */
  verificationToken: string;
  verificationCheckedAt?: Date | null;
  verifiedAt?: Date | null;
  /** Why the last check failed, shown to the tenant verbatim. */
  lastError?: string | null;
  /** Which check is outstanding. Absent on rows written before this existed. */
  stage?: DomainStage;
  sslStatus: SslStatus;
  sslCheckedAt?: Date | null;
  /** The host canonical for this tenant. At most one per college. */
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICollege extends Document {
  id: string;
  name: string;
  subdomain: string;
  customDomain?: string | null;
  templateId?: string | null;
  themePaletteId?: string | null;
  themeFontId?: string | null;
  status: "DRAFT" | "PENDING" | "ACTIVE" | "DISABLED";
  adoptable: boolean;
  collegeType?: string | null;
  isDemo: boolean;
  users: ICollegeUser[];
  /**
   * The draft. What the editor reads and autosaves into.
   *
   * Deliberately not renamed to `draftConfig`. Every tenant row already carries
   * this field, the editor and three API routes already write it, and a rename
   * is a migration that can only go wrong — for a field whose meaning has not
   * changed. What changed is that it is no longer what the public reads.
   */
  websiteConfig?: IWebsiteConfig | null;
  draftUpdatedAt?: Date | null;

  /**
   * The published site: what visitors get, and the only thing they get.
   *
   * Null for a tenant that has never pressed Publish. Public reads fall back to
   * the draft in that case, which is what keeps every site that was live before
   * this field existed live after it — no migration, no tenant going dark.
   */
  publishedConfig?: IWebsiteConfig | null;
  publishedAt?: Date | null;
  publishedByEmail?: string | null;
  /** Increments on every successful publish. 0 means never published. */
  publishedVersion: number;

  domains: ICustomDomain[];
  settings?: ISiteSettings | null;

  createdAt: Date;
  updatedAt: Date;
}

const CollegeUserSchema = new Schema<ICollegeUser>(
  {
    id: { type: String, required: true, default: () => new mongoose.Types.ObjectId().toString() },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    status: { type: String, enum: ["ACTIVE", "DISABLED"], default: "ACTIVE" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const SectionItemSchema = new Schema<ISectionItem>(
  {
    id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    title: { type: String, default: "Section" },
    sectionType: { type: String, default: "hero" },
    category: { type: String },
    code: { type: String, default: "" },
    sortOrder: { type: Number, default: 0 },
    /**
     * Which library template this section is showing.
     *
     * Declared rather than left to `strict: false`. This is the field the
     * variant swap cycles on — the whole reason swapping survives a user
     * editing a section's text — and it was persisting only because this
     * schema happens to accept unknown paths. A field load-bearing for a
     * feature should not depend on that staying true.
     */
    templateId: { type: String, default: null },
    variantIndex: { type: Number, default: 0 },
  },
  { _id: false, strict: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const PageItemSchema = new Schema<IPageItem>(
  {
    slug: { type: String, required: true },
    title: { type: String, required: true },
    sections: { type: [SectionItemSchema], default: [] },
  },
  { _id: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const WebsiteConfigSchema = new Schema<IWebsiteConfig>(
  {
    pages: { type: [PageItemSchema], default: [] },
  },
  { _id: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const SiteSettingsSchema = new Schema<ISiteSettings>(
  {
    seo: {
      indexingEnabled: { type: Boolean, default: true },
      title: { type: String, default: null },
      description: { type: String, default: null },
    },
    maintenance: {
      enabled: { type: Boolean, default: false },
      message: { type: String, default: null },
    },
    customCode: {
      headHtml: { type: String, default: null },
      bodyEndHtml: { type: String, default: null },
    },
    updatedAt: { type: Date, default: null },
  },
  { _id: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const CustomDomainSchema = new Schema<ICustomDomain>(
  {
    id: { type: String, required: true, default: () => new mongoose.Types.ObjectId().toString() },
    hostname: { type: String, required: true, lowercase: true, trim: true },
    status: {
      type: String,
      enum: ["PENDING_VERIFICATION", "VERIFIED", "ACTIVE", "FAILED", "DISCONNECTED"],
      default: "PENDING_VERIFICATION",
    },
    verificationToken: { type: String, required: true },
    verificationCheckedAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    stage: {
      type: String,
      enum: ["ownership", "routing", "edge", "tls", "done"],
      default: "ownership",
    },
    sslStatus: { type: String, enum: ["NONE", "PENDING", "ACTIVE", "ERROR"], default: "NONE" },
    sslCheckedAt: { type: Date, default: null },
    isPrimary: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const CollegeSchema = new Schema<ICollege>(
  {
    name: { type: String, required: true, trim: true },
    subdomain: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    customDomain: { type: String, sparse: true, unique: true, lowercase: true, trim: true, default: undefined },
    templateId: { type: String, default: null },
    themePaletteId: { type: String, default: null },
    themeFontId: { type: String, default: null },
    status: { type: String, enum: ["DRAFT", "PENDING", "ACTIVE", "DISABLED"], default: "DRAFT" },
    adoptable: { type: Boolean, default: true },
    collegeType: { type: String, default: null },
    isDemo: { type: Boolean, default: false },
    users: { type: [CollegeUserSchema], default: [] },
    websiteConfig: { type: WebsiteConfigSchema, default: null },
    draftUpdatedAt: { type: Date, default: null },
    publishedConfig: { type: WebsiteConfigSchema, default: null },
    publishedAt: { type: Date, default: null },
    publishedByEmail: { type: String, default: null },
    publishedVersion: { type: Number, default: 0 },
    domains: { type: [CustomDomainSchema], default: [] },
    settings: { type: SiteSettingsSchema, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      getters: true,
      transform: (_doc, ret: Record<string, any>) => {
        ret.id = ret._id ? ret._id.toString() : ret.id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      getters: true,
      transform: (_doc, ret: Record<string, any>) => {
        ret.id = ret._id ? ret._id.toString() : ret.id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

/**
 * One hostname, one tenant — enforced by the database, not by application code.
 *
 * A unique index on an array path gives this in both directions at once:
 * MongoDB rejects a second college claiming a hostname another college already
 * holds, *and* rejects one college holding the same hostname twice. The
 * find-then-insert version of this check loses to two requests arriving
 * together, and losing it means one tenant serving another tenant's site.
 *
 * Sparse, so the many colleges with no custom domain do not all collide on
 * "missing".
 */
CollegeSchema.index({ "domains.hostname": 1 }, { unique: true, sparse: true });

/**
 * The lookups every request makes, and none of them were indexed.
 *
 * Users are embedded in the college document, so `login()` resolves an account
 * with `College.findOne({ "users.email": ... })` and the admin routes resolve
 * one with `{ "users.id": ... }`. Neither path had an index, which makes both a
 * full scan of every college document — and a college document carries two
 * complete website configs made of raw section HTML, so these are among the
 * largest documents in the database.
 *
 * That is a performance problem and an availability one. An unauthenticated
 * caller can force a full scan of the largest collection ten times per fifteen
 * minutes per address from the login route alone, and the rate limiter is keyed
 * per email-plus-address, so varying the email varies the bucket. Indexing is
 * the fix; the limiter was never going to be one.
 *
 * Not unique: `users.email` should be, but making it so on an existing
 * deployment fails the index build if any duplicate exists, and taking the
 * database down to enforce a constraint the application already checks is the
 * wrong trade to make inside a security fix. Uniqueness is listed as a manual
 * follow-up.
 */
CollegeSchema.index({ "users.email": 1 });
CollegeSchema.index({ "users.id": 1 });

/** `adminSites()` and `adminOverview()` filter on this on every panel load. */
CollegeSchema.index({ isDemo: 1, createdAt: -1 });

export const College = mongoose.models.College || mongoose.model<ICollege>("College", CollegeSchema);
