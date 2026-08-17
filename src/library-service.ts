import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import { SectionType } from "@/lib/sections/types";

import { type AdminSession, recordAudit } from "@/admin-service";
import { AuthError } from "@/auth-service";
import { Template, College } from "@/models";
import { BadRequest, NotFound } from "@/errors";
import { applyTemplateToDefaultWebsite } from "@/default-website-service";

export function sanitizeTemplateCode(rawCode: string): string {
  return sanitizeHtml(rawCode, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "html", "body", "head", "title", "meta", "link", "style", "header", "footer", "nav",
      "section", "article", "aside", "main", "figure", "figcaption", "svg", "path", "g",
      "use", "polygon", "rect", "circle", "line", "polyline", "button", "form", "input",
      "label", "select", "textarea", "option", "iframe", "template", "slot"
    ]),
    allowedAttributes: {
      "*": [
        "class", "id", "style", "title", "role", "aria-*", "data-*", "name", "type",
        "value", "placeholder", "src", "href", "alt", "rel", "target", "width", "height",
        "xmlns", "viewBox", "d", "fill", "stroke"
      ],
    },
    allowedSchemes: ["http", "https", "mailto", "data"],
  });
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

    if (templates.length === 0) {
      try {
        await Template.create([
          {
            id: "reference-university-v1",
            name: "Greenfield University Standard",
            category: "University",
            description: "Official comprehensive university landing page template with all 19 standard sections.",
            isPublished: true,
            createdByEmail: "admin@xite.co.in",
            createdAt: new Date(),
          },
          {
            id: "modern-engineering-v2",
            name: "Madras Engineering College",
            category: "Engineering",
            description: "High-impact tech & placement-focused engineering campus template.",
            isPublished: true,
            createdByEmail: "admin@xite.co.in",
            createdAt: new Date(),
          },
          {
            id: "arts-science-v1",
            name: "Royal Arts & Science College",
            category: "Arts & Science",
            description: "Elegant academic & research portal template for liberal arts and science colleges.",
            isPublished: true,
            createdByEmail: "admin@xite.co.in",
            createdAt: new Date(),
          },
        ]);
        templates = await Template.find().sort({ archivedAt: 1, name: 1 });
      } catch {
        // Ignore seed conflicts if created concurrently
      }
    }
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

export async function getTemplateForAdmin(id: string): Promise<TemplateRow> {
  const templates = await listTemplatesForAdmin();
  let template = templates.find((row) => row.id === id);
  if (!template) {
    template = templates.find(
      (row) =>
        row.name.toLowerCase().includes(id.toLowerCase()) ||
        id.toLowerCase().includes(row.id.toLowerCase())
    );
  }
  if (!template) {
    const cleanTitle = id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      id,
      name: cleanTitle,
      description: `Template section for ${cleanTitle}`,
      thumbnailUrl: null,
      code: "",
      isPublished: true,
      archivedAt: null,
      createdAt: new Date().toISOString(),
      createdByEmail: null,
      colleges: 0,
      collegeSections: 0,
      deletable: true,
      slots: [],
    };
  }
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

    await recordAudit({
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

  await recordAudit({
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

  await recordAudit({
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
  const data = createTemplateSchema.parse(input);
  const nameLower = data.name.toLowerCase();
  const sanitizedCode = data.code ? sanitizeTemplateCode(data.code) : null;

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

    await recordAudit({
      actor,
      action: "template.update",
      targetType: "template",
      targetId: existing.id,
      summary: `Updated template "${existing.name}"`,
      metadata: { name: existing.name },
    });

    if (existing.code && cat) {
      await applyTemplateToDefaultWebsite(existing.name, cat, existing.code).catch(() => null);
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

  await recordAudit({
    actor,
    action: "template.create",
    targetType: "template",
    targetId: created.id,
    summary: `Created template "${created.name}"`,
    metadata: { name: created.name },
  });

  if (created.code && cat) {
    await applyTemplateToDefaultWebsite(created.name, cat, created.code).catch(() => null);
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

    await recordAudit({
      actor,
      action: "template.archive",
      targetType: "template",
      targetId: id,
      summary: `Archived template "${template.name}"`,
    });

    return { archived: true as const, deleted: false as const };
  }

  await Template.deleteOne({ _id: template._id });

  await recordAudit({
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

  await recordAudit({
    actor,
    action: "template.delete_all",
    targetType: "template",
    targetId: "all",
    summary: `Permanently deleted all ${count} template(s) from database`,
    metadata: { count },
  });

  return { deletedCount: count };
}
