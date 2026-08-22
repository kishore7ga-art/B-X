import { AuditLog, College } from "@/models";
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
 * Deliberately a strip, not an escape: the tenant asked for markup, so `<meta>`,
 * `<link>` and styling still work and their analytics tag simply does not run
 * until they connect their own domain. An allowlist parser would be better and
 * is a larger change; this errs toward removing too much.
 */
export function stripExecutable(html: string | null | undefined): string {
  if (!html) return "";
  return (
    html
      // Script elements, including an unclosed trailing one.
      .replace(/<script\b[\s\S]*?(?:<\/script\s*>|$)/gi, "")
      // Anything that can navigate or embed another origin's document.
      .replace(/<\s*(iframe|object|embed|applet|frame|frameset)\b[\s\S]*?(?:<\/\s*\1\s*>|$)/gi, "")
      // Inline handlers: onclick=, onerror=, onload= …
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      // javascript: and data: URLs in href/src.
      .replace(/\s(href|src)\s*=\s*(?:"\s*(?:javascript|data):[^"]*"|'\s*(?:javascript|data):[^']*'|(?:javascript|data):[^\s>]*)/gi, "")
  );
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
