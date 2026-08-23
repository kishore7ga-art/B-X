import sanitizeHtml from "sanitize-html";

import { AuditLog, College } from "@/models";
import { safeCss } from "@/lib/sections/sanitize-section-html";
import type { ICollege, ISiteSettings } from "@/models/colleges.model";

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

export const DEFAULT_SETTINGS: ISiteSettings = {
  seo: { indexingEnabled: true, title: null, description: null },
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

function withDefaults(settings: ISiteSettings | null | undefined): ISiteSettings {
  return {
    seo: {
      indexingEnabled: settings?.seo?.indexingEnabled ?? DEFAULT_SETTINGS.seo.indexingEnabled,
      title: settings?.seo?.title ?? null,
      description: settings?.seo?.description ?? null,
    },
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
    seo?: { indexingEnabled?: unknown; title?: unknown; description?: unknown };
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
    },
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
export function publicSettingsFor(
  college: ICollege,
  opts: { onOwnDomain: boolean },
): {
  indexingEnabled: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
  maintenanceEnabled: boolean;
  maintenanceMessage: string | null;
  headHtml: string;
  bodyEndHtml: string;
} {
  const settings = withDefaults(college.settings);
  const executable = opts.onOwnDomain && mayExecuteCustomCode(college);

  return {
    indexingEnabled: settings.seo.indexingEnabled,
    seoTitle: settings.seo.title ?? null,
    seoDescription: settings.seo.description ?? null,
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

export const __testing = { withDefaults, clampString, clampCode };
