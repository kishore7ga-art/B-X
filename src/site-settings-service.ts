import sanitizeHtml from "sanitize-html";

import { AuditLog, College } from "@/models";
import { safeCss } from "@/lib/sections/sanitize-section-html";
import type {
  IAeoSettings,
  ICollege,
  IFaqEntry,
  IGeoSettings,
  ISiteSettings,
} from "@/models/colleges.model";

/**
 * SEO, maintenance mode and custom code injection.
 *
 * All three were toggles in the settings screen that called `setState` and
 * showed a toast. Nothing was stored, and nothing downstream read them: a
 * tenant could switch on maintenance mode, be told "Maintenance mode
 * activated!", and their site would carry on serving normally to everyone.
 *
 * These are now persisted per tenant and enforced where they actually matter —
 * the published site render. A setting that saves but changes nothing is the
 * same lie with a database row behind it.
 */

export const MAX_CUSTOM_CODE_BYTES = 20_000;
export const MAX_SEO_TITLE = 120;
export const MAX_SEO_DESCRIPTION = 320;
export const MAX_MAINTENANCE_MESSAGE = 500;
export const MAX_GEO_FIELD = 160;
export const MAX_SERVICE_AREAS = 20;
export const MAX_SAME_AS = 20;
export const MAX_FAQS = 30;
export const MAX_FAQ_QUESTION = 300;
export const MAX_FAQ_ANSWER = 1_200;

/**
 * The schema.org types a tenant of this platform may declare itself as.
 *
 * An allowlist rather than a free string, because this value is emitted as
 * `"@type"` in JSON-LD: an arbitrary one produces structured data that
 * validates as nothing, which is worse than emitting none — a search engine
 * that cannot parse the block discards every fact in it, including the
 * correct ones.
 */
export const ORGANIZATION_TYPES = [
  "CollegeOrUniversity",
  "EducationalOrganization",
  "School",
  "HighSchool",
  "Organization",
] as const;

export const DEFAULT_ORGANIZATION_TYPE = "CollegeOrUniversity";

export const DEFAULT_SETTINGS: ISiteSettings = {
  seo: { indexingEnabled: true, title: null, description: null, ogImageUrl: null },
  geo: null,
  aeo: null,
  maintenance: { enabled: false, message: null },
  customCode: { headHtml: null, bodyEndHtml: null },
  updatedAt: null,
};

/**
 * Whether this tenant may inject executable code, and where.
 *
 * This is the sharpest decision in the file, so it is worth stating plainly.
 *
 * Every tenant site on `*.webxite.org` shares one registrable domain with the
 * platform. The session cookie is scoped to `.webxite.org`, it is `SameSite=None`
 * so it rides cross-site requests, and `isAllowedOrigin` in server.ts admits
 * every `*.webxite.org` origin for credentialed CORS. A `<script>` running on
 * `tenant-a.webxite.org` therefore sits inside the platform's cookie scope and
 * inside its CORS allowlist: it can make credentialed calls to the API as
 * whichever signed-in person is browsing, and read the answers. The cookie being
 * `httpOnly` prevents it being read directly and prevents none of that.
 *
 * So script is permitted only on a tenant's own verified custom domain, which is
 * a different registrable domain — outside the cookie scope, outside the CORS
 * allowlist, and therefore only able to attack the site's own visitors, which is
 * the tenant's own risk to take on their own property.
 *
 * On a platform subdomain the same code is stored verbatim but rendered with
 * executable content stripped. Storing it either way means a tenant who later
 * connects a domain does not have to retype anything.
 */
export function mayExecuteCustomCode(college: {
  domains?: { status?: string }[] | null;
}): boolean {
  return (college.domains ?? []).some((domain) => domain?.status === "ACTIVE");
}

/**
 * Removes anything that executes, for rendering on a shared platform subdomain.
 *
 * This was five regexes over a raw string, and the comment above them conceded
 * that "an allowlist parser would be better". It was not merely worse — it was
 * bypassable, in the ordinary ways a regex HTML filter always is:
 *
 *   - `<img/onerror=alert(1) src=x>` — the handler pattern required whitespace
 *     before `on`, and `/` is a perfectly good attribute separator in HTML;
 *   - `<a href=&#106;avascript:alert(1)>` — the scheme check ran against the
 *     raw bytes, and the browser decodes the entity afterwards;
 *   - `<button formaction="javascript:...">` — `formaction` was not one of the
 *     two attributes checked;
 *   - `<svg><animate onbegin=...>` inside a tag the strip never looked at.
 *
 * Any one of those puts script on `<tenant>.webxite.org`, which is inside the
 * session cookie's scope and inside the CORS allowlist — the exact outcome the
 * long comment on `mayExecuteCustomCode` above exists to prevent, and the reason
 * this function is the boundary rather than a nicety.
 *
 * It is `sanitize-html` now, which parses the markup rather than pattern-matching
 * it, so an attribute is either on the list or gone whatever it is spelled like.
 * The intent is unchanged and deliberately still a strip rather than an escape:
 * `<meta>`, `<link>` and styling keep working, and the tenant's analytics tag
 * simply does not run until they connect their own domain.
 */
export function stripExecutable(html: string | null | undefined): string {
  if (!html) return "";

  try {
    /**
     * `<style>` bodies are lifted out before the parser sees them.
     *
     * sanitize-html deletes the *text content* of a style element even when the
     * tag is allowed — it has no CSS parser and dropping the body is its safe
     * default. A tenant's head code is frequently nothing but a stylesheet, so
     * running it straight through would have silently emptied every one of
     * them: the tag would still be there and the CSS would be gone.
     *
     * `safeCss` is the same pass the section sanitiser applies, so CSS is
     * treated identically wherever it arrives from.
     */
    const styles: string[] = [];
    const withoutStyles = html.replace(
      /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi,
      (_full, css: string) => {
        if (css.trim()) styles.push(`<style>${safeCss(css)}</style>`);
        return "";
      },
    );

    const cleaned = sanitizeHtml(withoutStyles, {
      allowedTags: [
        // The point of head code that is not script: verification tags,
        // preconnects, stylesheets, favicons, social preview metadata.
        "meta", "link", "title", "base",
        // And ordinary markup, for a footer banner or a cookie notice.
        "div", "span", "p", "a", "img", "br", "hr", "small", "strong", "em",
        "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "noscript",
      ],
      allowedAttributes: {
        // No `on*` wildcard, so every event handler goes by omission.
        "*": ["style", "class", "id", "dir", "lang", "aria-*", "data-*"],
        meta: ["name", "property", "content", "charset", "http-equiv", "itemprop"],
        link: ["rel", "href", "type", "sizes", "media", "as", "crossorigin", "hreflang", "title"],
        a: ["href", "target", "rel", "title"],
        img: ["src", "alt", "width", "height", "loading", "decoding"],
      },
      /**
       * No `data:` anywhere, including on `<img>`.
       *
       * The section sanitiser allows `data:` images because inline thumbnails
       * are common in section markup. Head and body-end code has no such use,
       * and `data:` is how a document gets smuggled past a scheme check — so
       * the narrower rule applies to the narrower surface.
       */
      allowedSchemes: ["http", "https", "mailto", "tel"],
      allowedSchemesAppliedToAttributes: ["href", "src"],
      allowProtocolRelative: true,
      // Dropped whole, contents included, rather than unwrapped into the page.
      nonTextTags: ["script", "iframe", "object", "embed", "frame", "frameset", "applet", "textarea"],
      disallowedTagsMode: "discard",
    });

    return [...styles, cleaned].filter(Boolean).join("");
  } catch (error) {
    /**
     * Fails closed. A parser that could not read this markup is not evidence
     * that the markup is safe, and this string is about to be written into a
     * page with `dangerouslySetInnerHTML`.
     */
    console.error("[settings] custom code strip failed, emitting nothing:", (error as Error).message);
    return "";
  }
}

function clampString(
  value: unknown,
  max: number,
  field: string,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw Object.assign(new Error(`${field} must be text.`), { status: 400 });
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw Object.assign(
      new Error(`${field} is too long — ${trimmed.length} characters, limit ${max}.`),
      { status: 400 },
    );
  }
  return trimmed;
}

function clampCode(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw Object.assign(new Error(`${field} must be text.`), { status: 400 });
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Bytes rather than characters: this is stored in a document with a hard
  // 16MB ceiling that already holds two full site configs.
  const bytes = Buffer.byteLength(trimmed, "utf8");
  if (bytes > MAX_CUSTOM_CODE_BYTES) {
    throw Object.assign(
      new Error(`${field} is too large — ${bytes} bytes, limit ${MAX_CUSTOM_CODE_BYTES}.`),
      { status: 400 },
    );
  }
  return trimmed;
}

/**
 * An absolute http(s) URL, or nothing.
 *
 * These end up in `<meta property="og:image">` and in a JSON-LD `sameAs` array,
 * both of which a browser and a crawler will follow. A relative path there
 * resolves against whichever host is rendering — which for this platform means
 * one tenant's image URL resolving on another tenant's domain — and a
 * `javascript:` URL in a `<link>` or an anchor built from `sameAs` is script
 * execution. Parsed rather than pattern-matched, so a scheme cannot be smuggled
 * past with an entity or leading whitespace.
 */
function clampUrl(value: unknown, field: string): string | null {
  const text = clampString(value, 2_000, field);
  if (!text) return null;

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw Object.assign(
      new Error(`${field} must be a full web address, starting with https://`),
      { status: 400 },
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw Object.assign(
      new Error(`${field} must be an http or https address.`),
      { status: 400 },
    );
  }

  return parsed.toString();
}

/** A latitude or longitude, or nothing. Rejects the string "NaN" and friends. */
function clampCoordinate(value: unknown, field: string, limit: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(numeric)) {
    throw Object.assign(new Error(`${field} must be a number.`), { status: 400 });
  }
  if (numeric < -limit || numeric > limit) {
    throw Object.assign(
      new Error(`${field} must be between -${limit} and ${limit}.`),
      { status: 400 },
    );
  }
  return numeric;
}

/** ISO-3166-1 alpha-2, or nothing. */
function clampCountry(value: unknown): string | null {
  const text = clampString(value, 8, "Country");
  if (!text) return null;
  const upper = text.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) {
    throw Object.assign(
      new Error("Country must be a two-letter country code, such as IN or US."),
      { status: 400 },
    );
  }
  return upper;
}

function clampStringList(
  value: unknown,
  { max, maxLength, field, url }: { max: number; maxLength: number; field: string; url?: boolean },
): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw Object.assign(new Error(`${field} must be a list.`), { status: 400 });
  }
  if (value.length > max) {
    throw Object.assign(
      new Error(`${field} holds at most ${max} entries.`),
      { status: 400 },
    );
  }
  return value
    .map((entry) => (url ? clampUrl(entry, field) : clampString(entry, maxLength, field)))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeGeo(value: unknown): IGeoSettings | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") {
    throw Object.assign(new Error("Location must be an object."), { status: 400 });
  }
  const raw = value as Record<string, unknown>;

  const latitude = clampCoordinate(raw.latitude, "Latitude", 90);
  const longitude = clampCoordinate(raw.longitude, "Longitude", 180);

  /**
   * Both coordinates or neither.
   *
   * One of the pair locates nothing, and emitted alone it produces an `ICBM`
   * meta tag and a `GeoCoordinates` node that a consumer has to discard. A
   * half-filled form is a mistake worth naming rather than storing.
   */
  if ((latitude === null) !== (longitude === null)) {
    throw Object.assign(
      new Error("Give both a latitude and a longitude, or neither."),
      { status: 400 },
    );
  }

  const geo: IGeoSettings = {
    streetAddress: clampString(raw.streetAddress, MAX_GEO_FIELD, "Street address"),
    locality: clampString(raw.locality, MAX_GEO_FIELD, "City"),
    region: clampString(raw.region, MAX_GEO_FIELD, "Region"),
    postalCode: clampString(raw.postalCode, 32, "Postal code"),
    country: clampCountry(raw.country),
    latitude,
    longitude,
    telephone: clampString(raw.telephone, 40, "Telephone"),
    serviceAreas: clampStringList(raw.serviceAreas, {
      max: MAX_SERVICE_AREAS,
      maxLength: MAX_GEO_FIELD,
      field: "Service area",
    }),
  };

  // An object in which every field is empty is the tenant clearing the section.
  // Storing it would make "has a location" true for a site that has none, and
  // the renderer keys the whole geo block on that question.
  const hasAnything =
    Object.entries(geo).some(([key, val]) =>
      key === "serviceAreas" ? (val as string[]).length > 0 : val !== null,
    );

  return hasAnything ? geo : null;
}

function normalizeAeo(value: unknown): IAeoSettings | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") {
    throw Object.assign(new Error("Answer-engine settings must be an object."), { status: 400 });
  }
  const raw = value as Record<string, unknown>;

  const organizationType = clampString(raw.organizationType, 64, "Organisation type");
  if (
    organizationType &&
    !(ORGANIZATION_TYPES as readonly string[]).includes(organizationType)
  ) {
    throw Object.assign(
      new Error(`Organisation type must be one of: ${ORGANIZATION_TYPES.join(", ")}.`),
      { status: 400 },
    );
  }

  let foundingYear: number | null = null;
  if (raw.foundingYear !== undefined && raw.foundingYear !== null && raw.foundingYear !== "") {
    const year = Number(raw.foundingYear);
    const thisYear = new Date().getFullYear();
    if (!Number.isInteger(year) || year < 1000 || year > thisYear) {
      throw Object.assign(
        new Error(`Founding year must be a whole year between 1000 and ${thisYear}.`),
        { status: 400 },
      );
    }
    foundingYear = year;
  }

  const faqsRaw = raw.faqs;
  let faqs: IFaqEntry[] = [];
  if (faqsRaw !== undefined && faqsRaw !== null) {
    if (!Array.isArray(faqsRaw)) {
      throw Object.assign(new Error("Questions must be a list."), { status: 400 });
    }
    if (faqsRaw.length > MAX_FAQS) {
      throw Object.assign(
        new Error(`At most ${MAX_FAQS} questions.`),
        { status: 400 },
      );
    }
    faqs = faqsRaw
      .map((entry) => {
        const item = (entry ?? {}) as Record<string, unknown>;
        const question = clampString(item.question, MAX_FAQ_QUESTION, "Question");
        const answer = clampString(item.answer, MAX_FAQ_ANSWER, "Answer");
        // A question with no answer is not a FAQ entry, and `FAQPage` requires
        // both — a half-filled row would invalidate the whole block.
        return question && answer ? { question, answer } : null;
      })
      .filter((entry): entry is IFaqEntry => entry !== null);
  }

  const aeo: IAeoSettings = {
    organizationType,
    legalName: clampString(raw.legalName, MAX_GEO_FIELD, "Legal name"),
    foundingYear,
    sameAs: clampStringList(raw.sameAs, {
      max: MAX_SAME_AS,
      maxLength: 2_000,
      field: "Profile link",
      url: true,
    }),
    faqs,
  };

  const hasAnything =
    aeo.organizationType !== null ||
    aeo.legalName !== null ||
    aeo.foundingYear !== null ||
    (aeo.sameAs?.length ?? 0) > 0 ||
    (aeo.faqs?.length ?? 0) > 0;

  return hasAnything ? aeo : null;
}

function withDefaults(settings: ISiteSettings | null | undefined): ISiteSettings {
  return {
    seo: {
      indexingEnabled: settings?.seo?.indexingEnabled ?? DEFAULT_SETTINGS.seo.indexingEnabled,
      title: settings?.seo?.title ?? null,
      description: settings?.seo?.description ?? null,
      ogImageUrl: settings?.seo?.ogImageUrl ?? null,
    },
    geo: settings?.geo ?? null,
    aeo: settings?.aeo ?? null,
    maintenance: {
      enabled: settings?.maintenance?.enabled ?? false,
      message: settings?.maintenance?.message ?? null,
    },
    customCode: {
      headHtml: settings?.customCode?.headHtml ?? null,
      bodyEndHtml: settings?.customCode?.bodyEndHtml ?? null,
    },
    updatedAt: settings?.updatedAt ?? null,
  };
}

export type SettingsView = ISiteSettings & {
  /** Whether script in `customCode` will actually run, and why not if it will not. */
  customCodeExecutes: boolean;
  customCodeNotice: string | null;
};

function toView(college: ICollege): SettingsView {
  const settings = withDefaults(college.settings);
  const executes = mayExecuteCustomCode(college);

  return {
    ...settings,
    customCodeExecutes: executes,
    customCodeNotice: executes
      ? null
      : "Scripts run once you connect your own domain. On a webxite.org address they are saved but not executed, because that address shares a domain with the platform.",
  };
}

export async function getSettings(collegeId: string): Promise<SettingsView> {
  const college = (await College.findById(collegeId).lean()) as ICollege | null;
  if (!college) throw Object.assign(new Error("College not found"), { status: 404 });
  return toView(college);
}

/**
 * Applies a partial update.
 *
 * Partial on purpose: the settings screen has three independent cards, and a
 * PUT of the whole object from one of them would silently revert whatever
 * another tab changed in the meantime.
 */
export async function updateSettings(
  collegeId: string,
  patch: unknown,
  actorEmail: string | null,
): Promise<SettingsView> {
  const college = (await College.findById(collegeId).lean()) as ICollege | null;
  if (!college) throw Object.assign(new Error("College not found"), { status: 404 });

  const body = (patch ?? {}) as {
    seo?: {
      indexingEnabled?: unknown;
      title?: unknown;
      description?: unknown;
      ogImageUrl?: unknown;
    };
    geo?: unknown;
    aeo?: unknown;
    maintenance?: { enabled?: unknown; message?: unknown };
    customCode?: { headHtml?: unknown; bodyEndHtml?: unknown };
  };

  const current = withDefaults(college.settings);
  const next: ISiteSettings = {
    seo: {
      indexingEnabled:
        body.seo?.indexingEnabled === undefined
          ? current.seo.indexingEnabled
          : Boolean(body.seo.indexingEnabled),
      title:
        body.seo?.title === undefined
          ? current.seo.title ?? null
          : clampString(body.seo.title, MAX_SEO_TITLE, "SEO title"),
      description:
        body.seo?.description === undefined
          ? current.seo.description ?? null
          : clampString(body.seo.description, MAX_SEO_DESCRIPTION, "SEO description"),
      ogImageUrl:
        body.seo?.ogImageUrl === undefined
          ? current.seo.ogImageUrl ?? null
          : clampUrl(body.seo.ogImageUrl, "Social preview image"),
    },
    // Whole-object replacement rather than a field merge, because these two are
    // edited as a form: clearing the street address has to be able to clear it,
    // and a per-field merge cannot tell "left blank" from "not sent".
    geo: body.geo === undefined ? current.geo ?? null : normalizeGeo(body.geo),
    aeo: body.aeo === undefined ? current.aeo ?? null : normalizeAeo(body.aeo),
    maintenance: {
      enabled:
        body.maintenance?.enabled === undefined
          ? current.maintenance.enabled
          : Boolean(body.maintenance.enabled),
      message:
        body.maintenance?.message === undefined
          ? current.maintenance.message ?? null
          : clampString(body.maintenance.message, MAX_MAINTENANCE_MESSAGE, "Maintenance message"),
    },
    customCode: {
      headHtml:
        body.customCode?.headHtml === undefined
          ? current.customCode.headHtml ?? null
          : clampCode(body.customCode.headHtml, "Header code"),
      bodyEndHtml:
        body.customCode?.bodyEndHtml === undefined
          ? current.customCode.bodyEndHtml ?? null
          : clampCode(body.customCode.bodyEndHtml, "Footer code"),
    },
    updatedAt: new Date(),
  };

  await College.updateOne({ _id: collegeId }, { $set: { settings: next } });

  // Recorded field by field. "Settings updated" in an audit log answers none of
  // the questions an audit log is read to answer — maintenance mode going on and
  // off is exactly the event somebody will later need to place in time.
  const changed: Record<string, unknown> = {};
  if (next.seo.indexingEnabled !== current.seo.indexingEnabled) {
    changed.seoIndexingEnabled = next.seo.indexingEnabled;
  }
  if (next.maintenance.enabled !== current.maintenance.enabled) {
    changed.maintenanceEnabled = next.maintenance.enabled;
  }
  if (next.customCode.headHtml !== current.customCode.headHtml) {
    changed.headHtmlBytes = Buffer.byteLength(next.customCode.headHtml ?? "", "utf8");
  }
  if (next.customCode.bodyEndHtml !== current.customCode.bodyEndHtml) {
    changed.bodyEndHtmlBytes = Buffer.byteLength(next.customCode.bodyEndHtml ?? "", "utf8");
  }

  if (Object.keys(changed).length > 0) {
    await AuditLog.create({
      action: "SITE_SETTINGS_UPDATED",
      tenantId: collegeId,
      details: { ...changed, actor: actorEmail },
    }).catch(() => null);
  }

  return toView({ ...college, settings: next } as ICollege);
}

/**
 * What the published site render needs, already resolved.
 *
 * Custom code arrives here in the form it should actually be emitted in: full
 * on a tenant's own domain, executable content stripped on a platform
 * subdomain. The renderer does not get to make that decision, because there
 * would then be two places that could get it wrong.
 */
export type PublicSiteSettings = {
  indexingEnabled: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  ogImageUrl: string | null;
  /** The institution's own name, for `og:site_name` and the structured data. */
  siteName: string;
  geo: IGeoSettings | null;
  aeo: IAeoSettings | null;
  maintenanceEnabled: boolean;
  maintenanceMessage: string | null;
  headHtml: string;
  bodyEndHtml: string;
};

export function publicSettingsFor(
  college: ICollege,
  opts: { onOwnDomain: boolean },
): PublicSiteSettings {
  const settings = withDefaults(college.settings);
  const executable = opts.onOwnDomain && mayExecuteCustomCode(college);

  return {
    indexingEnabled: settings.seo.indexingEnabled,
    seoTitle: settings.seo.title ?? null,
    seoDescription: settings.seo.description ?? null,
    ogImageUrl: settings.seo.ogImageUrl ?? null,
    siteName: college.name,
    /**
     * Sent to the renderer as data, never as markup.
     *
     * The renderer builds the meta tags and the JSON-LD from these fields
     * itself, so nothing a tenant types can become a tag: a `</script>` in a
     * FAQ answer closes the block it is serialised into, and that is the one
     * way structured data turns into script injection.
     */
    geo: settings.geo ?? null,
    aeo: settings.aeo ?? null,
    maintenanceEnabled: settings.maintenance.enabled,
    maintenanceMessage: settings.maintenance.message ?? null,
    headHtml: executable
      ? settings.customCode.headHtml ?? ""
      : stripExecutable(settings.customCode.headHtml),
    bodyEndHtml: executable
      ? settings.customCode.bodyEndHtml ?? ""
      : stripExecutable(settings.customCode.bodyEndHtml),
  };
}

export const __testing = {
  withDefaults,
  clampString,
  clampCode,
  clampUrl,
  clampCoordinate,
  clampCountry,
  normalizeGeo,
  normalizeAeo,
};
