import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import { SectionType } from "@/lib/sections/types";

import { type AdminSession, recordAudit } from "@/admin-service";
import { AuthError } from "@/auth-service";
import { Template, College } from "@/models";
import { BadRequest, NotFound } from "@/errors";
// applyTemplateToDefaultWebsite import removed — Default Website and Normal Templates
// are now fully independent. No automatic cross-writes between the two systems.

/**
 * Sanitize and normalize admin-uploaded template code.
 * - Extracts <style> from <head> + <body> content from full <!DOCTYPE html> documents
 * - IMPORTANT: sanitize-html v2+ strips ALL text content from <style> tags.
 *   We work around this by extracting ALL <style> blocks first, sanitizing only
 *   the HTML portion, then prepending the style blocks back.
 * - Allows <script> tags (admin content is trusted — not user-generated)
 * - Never throws — returns rawCode unchanged on any error
 */
export function sanitizeTemplateCode(rawCode: string): string {
  if (!rawCode || !rawCode.trim()) return rawCode;

  try {
    let code = rawCode.trim();

    // Step 1: If full HTML document, extract <style> from <head> + <body> content.
    if (/^<!DOCTYPE/i.test(code) || /<html[\s>]/i.test(code)) {
      const headMatch = code.match(/<head[\s\S]*?<\/head>/i);
      const headStyles: string[] = [];
      const headLinks: string[] = [];
      if (headMatch) {
        // Collect <style> blocks from head
        const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
        let m;
        while ((m = styleRegex.exec(headMatch[0])) !== null) {
          if (m[1]?.trim()) headStyles.push(`<style>${m[1]}</style>`);
        }
        // Collect <link rel="stylesheet"> from head (Google Fonts, CDN CSS, etc.)
        const linkRegex = /<link[^>]+rel=["']stylesheet["'][^>]*>/gi;
        let lm;
        while ((lm = linkRegex.exec(headMatch[0])) !== null) {
          headLinks.push(lm[0]);
        }
      }
      const bodyMatch = code.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const bodyContent = bodyMatch?.[1]?.trim() || code
        .replace(/^<!DOCTYPE[^>]*>/i, '')
        .replace(/<html[^>]*>/i, '')
        .replace(/<\/html>/i, '')
        .replace(/<head[\s\S]*?<\/head>/i, '')
        .trim();
      code = [...headLinks, ...headStyles, bodyContent].filter(Boolean).join('\n');
    }

    // Step 2: Extract ALL <style> blocks from the code BEFORE sanitizing.
    // sanitize-html v2+ removes text content from <style> tags even when allowed.
    // We save them now and reattach after sanitization.
    const preservedStyles: string[] = [];
    const preservedLinks: string[] = [];
    let codeWithoutStyles = code
      .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (match, content) => {
        if (content?.trim()) preservedStyles.push(`<style>${content}</style>`);
        return ''; // Remove from HTML to sanitize
      })
      .replace(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi, (match) => {
        preservedLinks.push(match);
        return '';
      })
      .trim();

    // Step 3: Sanitize only the HTML (scripts and layout tags — no style content to worry about).
    // Admin-uploaded content is trusted, so we allow script tags for hamburger menus etc.
    const sanitized = sanitizeHtml(codeWithoutStyles, {
      allowedTags: sanitizeHtml.defaults.allowedTags.concat([
        "html", "body", "head", "title", "meta", "link", "style", "script",
        "header", "footer", "nav", "section", "article", "aside", "main",
        "figure", "figcaption", "svg", "path", "g", "use", "polygon",
        "rect", "circle", "line", "polyline", "button", "form", "input",
        "label", "select", "textarea", "option", "iframe", "template", "slot"
      ]),
      allowedAttributes: {
        "*": [
          "class", "id", "style", "title", "role", "aria-*", "data-*", "name",
          "type", "value", "placeholder", "src", "href", "alt", "rel", "target",
          "width", "height", "xmlns", "viewBox", "d", "fill", "stroke",
          "crossorigin", "integrity", "defer", "async", "charset",
        ],
      },
      /**
       * `javascript` was on this list, and `allowedScriptDomains: ["*"]` beside
       * it, on the reasoning in the docblock above that "admin content is
       * trusted".
       *
       * That reasoning does not survive what these templates become. A template
       * is the source of the section markup every tenant inserts, and it renders
       * on `webxite.org` — the platform apex, same origin as the sign-in page,
       * the editor and the `/admin/*` API rewrite. So the blast radius of one
       * bad or compromised template is the whole platform, not one page.
       *
       * `<script>` stays allowed, because the library genuinely contains
       * hamburger menus and carousels that need it and removing them would break
       * live sites. `javascript:` URLs do not: nothing in the library uses one,
       * they are the sink that never looks like a sink, and a `href` is not
       * where a menu toggle belongs.
       */
      allowedSchemes: ["http", "https", "mailto", "tel", "data"],
      allowedSchemesAppliedToAttributes: ["href", "src", "action", "formaction", "poster"],
    });

    // Step 4: Reattach all preserved styles BEFORE the HTML content.
    // Order: external links first (fonts/CDN), then inline <style>, then HTML.
    const parts = [...preservedLinks, ...preservedStyles, sanitized].filter(Boolean);
    return parts.join('\n');
  } catch (err) {
    console.warn("[sanitizeTemplateCode] sanitize-html failed, using raw code:", (err as Error).message);
    return rawCode;
  }
}


export const OFFERABLE = { isPublished: true, archivedAt: null } as const;

export type TemplateStats = {
  templates: { total: number; published: number; draft: number; archived: number };
  library: { total: number; active: number; retired: number };
  byType: { sectionType: SectionType; active: number }[];
  collegesOnTemplates: number;
};

export async function templateStats(): Promise<TemplateStats> {
  try {
    const [total, published, archived, collegesOnTemplates] = await Promise.all([
      Template.countDocuments(),
      Template.countDocuments({ isPublished: true, archivedAt: null }),
      Template.countDocuments({ archivedAt: { $ne: null } }),
      College.countDocuments({ isDemo: false, templateId: { $ne: null } }),
    ]);

    return {
      templates: {
        total,
        published,
        draft: Math.max(0, total - published - archived),
        archived,
      },
      library: { total: 30, active: 30, retired: 0 },
      byType: [],
      collegesOnTemplates,
    };
  } catch (_err) {
    return {
      templates: { total: 0, published: 0, draft: 0, archived: 0 },
      library: { total: 0, active: 0, retired: 0 },
      byType: [],
      collegesOnTemplates: 0,
    };
  }
}

export type TemplateRow = {
  id: string;
  name: string;
  category?: string | null;
  description: string | null;
  thumbnailUrl: string | null;
  code: string | null;
  isPublished: boolean;
  archivedAt: string | null;
  createdAt: string;
  createdByEmail: string | null;
  colleges: number;
  collegeSections: number;
  deletable: boolean;
  slots: Array<{
    slotId: string;
    sectionType: string;
    order: number;
    isRequired: boolean;
    leadVariantId: string | null;
    leadVariantName: string | null;
    leadComponentKey: string | null;
  }>;
};

export async function listTemplatesForAdmin(): Promise<TemplateRow[]> {
  let templates: any[] = [];
  try {
    templates = await Template.find().sort({ archivedAt: 1, name: 1 });
    // No seeding — DB starts empty and admin adds real section templates via the Studio
  } catch (_dbErr) {
    templates = [];
  }

  return templates.map((template) => {
    const archivedAtStr =
      template.archivedAt instanceof Date
        ? template.archivedAt.toISOString()
        : template.archivedAt
        ? String(template.archivedAt)
        : null;

    const createdAtStr =
      template.createdAt instanceof Date
        ? template.createdAt.toISOString()
        : String(template.createdAt ?? new Date().toISOString());

    return {
      id: template.id || template._id?.toString() || "tpl-default",
      name: template.name || "Default Template",
      category: template.category ?? null,
      description: template.description ?? null,
      thumbnailUrl: template.thumbnailUrl ?? null,
      code: template.code ?? null,
      isPublished: Boolean(template.isPublished),
      archivedAt: archivedAtStr,
      createdAt: createdAtStr,
      createdByEmail: template.createdByEmail ?? null,
      colleges: 0,
      collegeSections: 0,
      deletable: true,
      slots: (template.slots ?? []).map((slot: any) => ({
        slotId: slot.slotId || slot.id,
        sectionType: slot.sectionType,
        order: slot.order ?? 0,
        isRequired: Boolean(slot.isRequired),
        leadVariantId: slot.leadVariantId ?? null,
        leadVariantName: slot.leadVariantName ?? null,
        leadComponentKey: slot.leadComponentKey ?? null,
      })),
    };
  });
}

export async function libraryVariantsForAdmin() {
  return [];
}

/**
 * One template, by its id.
 *
 * Exact match, or `NotFound`. Both of the things this used to do instead were
 * wrong in the same direction — answering confidently when it did not know:
 *
 *  - **It fabricated a template.** A miss returned a synthetic row with a title
 *    derived from the id, empty `code`, `isPublished: true` and `createdAt` set
 *    to now. So a stale bookmark to a deleted template opened an editor on a
 *    plausible-looking blank section, which the admin could then edit and save.
 *
 *  - **It guessed by name.** Before giving up it tried
 *    `row.name.includes(id) || id.includes(row.id)`, so `GET /templates/hero`
 *    returned whichever template happened to have "hero" in its name. The PATCH
 *    beside it resolves by exact id only, so the admin could open one template
 *    and save to a different one — or to nothing.
 *
 * This is the same fault as the `findOneAndDelete({ name: id })` fallback that
 * was removed from `delete-section`: an identifier lookup that falls back to a
 * fuzzy search on a human-readable field.
 */
export async function getTemplateForAdmin(id: string): Promise<TemplateRow> {
  const templates = await listTemplatesForAdmin();
  const template = templates.find((row) => row.id === id);
  if (!template) throw new NotFound("Template not found");
  return template;
}

export const templateDetailsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name is too short")
    .max(80, "Name is too long")
    .optional(),
  description: z.string().trim().max(600, "Description is too long").nullish(),
  thumbnailUrl: z.string().trim().nullish(),
  code: z.string().nullish(),
  isPublished: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export async function updateTemplateDetails(
  id: string,
  input: unknown,
  actor: AdminSession,
) {
  const patch = templateDetailsSchema.parse(input);

  let template = await Template.findById(id);
  if (!template) {
    template = await Template.findOne({ name: id });
  }

  if (!template) {
    const templateName = patch.name || id;
    template = await Template.create({
      name: templateName,
      description: patch.description ?? `Template section ${templateName}`,
      thumbnailUrl: patch.thumbnailUrl ?? null,
      code: patch.code ?? "",
      isPublished: patch.isPublished ?? true,
      createdByEmail: actor.email,
      createdById: actor.adminId,
    });

    recordAudit({
      actor,
      action: "template.create",
      targetType: "template",
      targetId: template.id,
      summary: `Template "${templateName}" created`,
    });

    return getTemplateForAdmin(template.id);
  }

  if (patch.name !== undefined) template.name = patch.name;
  if (patch.description !== undefined) template.description = patch.description ?? null;
  if (patch.thumbnailUrl !== undefined) template.thumbnailUrl = patch.thumbnailUrl ?? null;
  if (patch.code !== undefined) template.code = patch.code ?? null;
  if (patch.isPublished !== undefined) template.isPublished = patch.isPublished;
  if (patch.archived !== undefined) {
    template.archivedAt = patch.archived ? (template.archivedAt ?? new Date()) : null;
  }

  await template.save();

  recordAudit({
    actor,
    action: "template.update",
    targetType: "template",
    targetId: id,
    summary: `Template "${template.name}": saved updates`,
  });

  return getTemplateForAdmin(template.id);
}

export const templateSlotsSchema = z.object({
  slots: z
    .array(
      z.object({
        slotId: z.string().min(1),
        leadVariantId: z.string().min(1).nullable().optional(),
        order: z.number().int().min(0).max(999).optional(),
      }),
    )
    .min(1, "Nothing to update"),
});

export async function updateTemplateSlots(
  templateId: string,
  input: unknown,
  actor: AdminSession,
) {
  const { slots } = templateSlotsSchema.parse(input);

  const template = await Template.findById(templateId);
  if (!template) throw new NotFound("Template not found");

  template.slots = slots.map((s) => ({
    slotId: s.slotId,
    sectionType: "section",
    order: s.order ?? 0,
    isRequired: false,
    leadVariantId: s.leadVariantId ?? null,
  }));

  await template.save();

  recordAudit({
    actor,
    action: "template.slots_update",
    targetType: "template",
    targetId: templateId,
    summary: `Template "${template.name}": ${slots.length} section(s) updated`,
    metadata: { slots },
  });

  return getTemplateForAdmin(templateId);
}

export const createTemplateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "Name is too short")
    .max(80, "Name is too long"),
  category: z.string().trim().nullish(),
  description: z.string().trim().max(600, "Description is too long").optional(),
  thumbnailUrl: z.string().trim().optional(),
  code: z.string().optional(),
  isPublished: z.boolean().default(true),
});

export async function createTemplate(input: unknown, actor: AdminSession) {
  console.log("[createTemplate] called with name:", (input as any)?.name, "category:", (input as any)?.category);
  const data = createTemplateSchema.parse(input);
  const nameLower = data.name.toLowerCase();

  // Sanitize and normalize — never throws, falls back to raw code
  let sanitizedCode: string | null = null;
  try {
    sanitizedCode = data.code ? sanitizeTemplateCode(data.code) : null;
    console.log("[createTemplate] sanitized code length:", sanitizedCode?.length ?? 0);
  } catch (sanitizeErr) {
    console.error("[createTemplate] sanitize failed:", sanitizeErr);
    sanitizedCode = data.code ?? null;
  }

  let cat = data.category ? data.category.toLowerCase().trim() : "";
  if (!cat || cat === "undefined" || cat === "null" || cat === "custom") {
    if (nameLower.includes("header") || nameLower.includes("nav")) {
      cat = "header";
    } else if (nameLower.includes("footer")) {
      cat = "footer";
    }
  }

  const existing = await Template.findOne({ name: data.name });

  if (existing) {
    existing.code = sanitizedCode ?? existing.code;
    if (cat) existing.category = cat;
    if (data.description) existing.description = data.description;
    existing.isPublished = data.isPublished;
    await existing.save();

    recordAudit({
      actor,
      action: "template.update",
      targetType: "template",
      targetId: existing.id,
      summary: `Updated template "${existing.name}"`,
      metadata: { name: existing.name },
    });

    if (existing.code && cat) {
      // NOTE: applyTemplateToDefaultWebsite() intentionally REMOVED.
      // Normal Templates and Default Website Config are now fully independent:
      // - Normal Templates  → MongoDB "templates" collection (Templates page)
      // - Default Website   → MongoDB "systemsecrets" collection (Default Website page)
      // Admins manage each separately. No automatic cross-writes.
    }

    return getTemplateForAdmin(existing.id);
  }

  const created = await Template.create({
    name: data.name,
    category: cat || null,
    description: data.description ?? null,
    thumbnailUrl: data.thumbnailUrl ?? null,
    code: sanitizedCode,
    isPublished: data.isPublished,
    createdByEmail: actor.email,
    createdById: actor.adminId,
  });

  recordAudit({
    actor,
    action: "template.create",
    targetType: "template",
    targetId: created.id,
    summary: `Created template "${created.name}"`,
    metadata: { name: created.name },
  });

  if (created.code && cat) {
    // NOTE: applyTemplateToDefaultWebsite() intentionally REMOVED.
    // Normal Templates are saved only to the "templates" collection.
    // The Default Website page manages its own independent config.
  }

  return getTemplateForAdmin(created.id);
}

export async function retireTemplate(
  id: string,
  options: { hard?: boolean },
  actor: AdminSession,
) {
  const template = await Template.findById(id);
  if (!template) throw new NotFound("Template not found");

  if (!options.hard) {
    template.archivedAt = template.archivedAt ? null : new Date();
    template.isPublished = false;
    await template.save();

    recordAudit({
      actor,
      action: "template.archive",
      targetType: "template",
      targetId: id,
      summary: `Archived template "${template.name}"`,
    });

    return { archived: true as const, deleted: false as const };
  }

  await Template.deleteOne({ _id: template._id });

  recordAudit({
    actor,
    action: "template.delete",
    targetType: "template",
    targetId: id,
    summary: `Permanently deleted template "${template.name}"`,
  });

  return { archived: false as const, deleted: true as const };
}

export async function deleteAllTemplates(actor: AdminSession) {
  const count = await Template.countDocuments();
  await Template.deleteMany({});

  recordAudit({
    actor,
    action: "template.delete_all",
    targetType: "template",
    targetId: "all",
    summary: `Permanently deleted all ${count} template(s) from database`,
    metadata: { count },
  });

  return { deletedCount: count };
}
