import { z } from "zod";
import sanitizeHtml from "sanitize-html";
import type { SectionType } from "@/generated/prisma/enums";

import { type AdminSession, recordAudit } from "@/admin-service";
import { AuthError } from "@/auth-service";
import { Template, College } from "@/models";
import { BadRequest, NotFound } from "@/errors";

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
      draft: total - published - archived,
      archived,
    },
    library: { total: 30, active: 30, retired: 0 },
    byType: [],
    collegesOnTemplates,
  };
}

export type TemplateRow = {
  id: string;
  name: string;
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
  const templates = await Template.find().sort({ archivedAt: 1, name: 1 });

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
      id: template.id,
      name: template.name,
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
  description: z.string().trim().max(600, "Description is too long").optional(),
  thumbnailUrl: z.string().trim().optional(),
  code: z.string().optional(),
  isPublished: z.boolean().default(true),
});

export async function createTemplate(input: unknown, actor: AdminSession) {
  const data = createTemplateSchema.parse(input);

  const existing = await Template.findOne({ name: data.name });
  if (existing) {
    throw new AuthError("A template with that name already exists", 409);
  }

  const sanitizedCode = data.code ? sanitizeTemplateCode(data.code) : null;

  const created = await Template.create({
    name: data.name,
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
