import { z } from "zod";

import { type AdminSession, recordAudit } from "@/admin-service";
import { AuthError } from "@/auth-service";
import { prisma } from "@/db";
import type { SectionType } from "@/generated/prisma/enums";
import { BadRequest, NotFound } from "@/sections-service";

/**
 * The section library and the templates assembled from it, as an admin sees them.
 *
 * One thing shapes every write in here: a template's composition is not a join
 * table that can be deleted and rebuilt. `sections` cascades from `templates` and
 * `college_sections` cascades from `sections`, so "replace this template's section
 * list" would take the content of every college using it — 28 rows for Radian as
 * this is written. So swapping a design is an UPDATE to one column
 * (`updateTemplateSlots`), and removing a template archives it unless nothing
 * depends on it at all (`retireTemplate`).
 */

/**
 * What "a college may pick this" means, in one place.
 *
 * It had no meaning at all before the publish toggle went in, and that is worth
 * recording: `listTemplates()` selected every row, so `archivedAt` never hid
 * anything from the gallery despite its own comment saying "archiving hides it from
 * the picker". The admin panel drew the badge, the gallery ignored it.
 *
 * Adding `isPublished` without this would have repeated the mistake with a second
 * column — a toggle in the admin UI that changes a boolean and nothing else. So
 * every path a college can reach a template through imports this: the gallery, the
 * theme picker, the preview, "start with this design", and the template cycler.
 *
 * The admin's own list deliberately does not use it. Seeing drafts is the point of
 * that screen.
 */
export const OFFERABLE = { isPublished: true, archivedAt: null } as const;

export type TemplateStats = {
  templates: { total: number; published: number; draft: number; archived: number };
  /**
   * The library, which is `section_variants` — not `sections`.
   *
   * The guide counts `Section where isActive`, which in this schema is the
   * per-template slot and has no such column. The reusable design is
   * `SectionVariant`, and it is the one that carries `isActive`.
   */
  library: { total: number; active: number; retired: number };
  byType: { sectionType: SectionType; active: number }[];
  /** Colleges actually sitting on a template, which is what makes a delete unsafe. */
  collegesOnTemplates: number;
};

export async function templateStats(): Promise<TemplateStats> {
  const [
    total,
    published,
    archived,
    libraryTotal,
    libraryActive,
    grouped,
    collegesOnTemplates,
  ] = await Promise.all([
    prisma.template.count(),
    prisma.template.count({ where: { isPublished: true, archivedAt: null } }),
    prisma.template.count({ where: { archivedAt: { not: null } } }),
    prisma.sectionVariant.count(),
    prisma.sectionVariant.count({ where: { isActive: true } }),
    prisma.sectionVariant.groupBy({
      by: ["sectionType"],
      where: { isActive: true },
      _count: true,
    }),
    prisma.college.count({ where: { isDemo: false, templateId: { not: null } } }),
  ]);

  return {
    templates: {
      total,
      published,
      // Not "total - published": a template can be both unpublished and archived,
      // and counting the difference would file it under draft, which reads as
      // "still being built" for something that was withdrawn.
      draft: await prisma.template.count({
        where: { isPublished: false, archivedAt: null },
      }),
      archived,
    },
    library: {
      total: libraryTotal,
      active: libraryActive,
      retired: libraryTotal - libraryActive,
    },
    byType: grouped
      .map((row) => ({ sectionType: row.sectionType, active: row._count }))
      .sort((a, b) => a.sectionType.localeCompare(b.sectionType)),
    collegesOnTemplates,
  };
}

export type TemplateSlot = {
  /** The `sections` row — this template's slot for that type. */
  slotId: string;
  sectionType: SectionType;
  order: number;
  isRequired: boolean;
  /** The library design this template leads with, if it still names a live one. */
  leadVariantId: string | null;
  leadVariantName: string | null;
  leadComponentKey: string | null;
};

export type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  thumbnailUrl: string | null;
  isPublished: boolean;
  archivedAt: string | null;
  createdAt: string;
  createdByEmail: string | null;
  slots: TemplateSlot[];
  /** Colleges currently pointed at it. */
  colleges: number;
  /** Sections those colleges have built from it — what a delete would destroy. */
  collegeSections: number;
  /**
   * Whether a real delete is safe, rather than whether the button should exist.
   *
   * The schema already answers this in `Template.archivedAt`'s own comment: "A
   * real delete is only offered when no college uses it." Computed here rather
   * than guessed in the UI, because the frontend cannot see the cascade and the
   * cost of getting it wrong is somebody else's site.
   */
  deletable: boolean;
};

/**
 * Every template, drafts and archived included.
 *
 * `include: { sections: { include: { section: true } } }` from the guide does not
 * translate: there is no `TemplateSection` join holding a library item. A
 * template's composition is its `sections` rows — one per section type it offers —
 * each naming the library design it leads with via `defaultVariantId`.
 */
export async function listTemplatesForAdmin(): Promise<TemplateRow[]> {
  const templates = await prisma.template.findMany({
    orderBy: [{ archivedAt: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      thumbnailUrl: true,
      isPublished: true,
      archivedAt: true,
      createdAt: true,
      createdByEmail: true,
      _count: { select: { colleges: true } },
      sections: {
        orderBy: { defaultOrder: "asc" },
        select: {
          id: true,
          sectionType: true,
          defaultOrder: true,
          isRequired: true,
          defaultVariant: {
            select: { id: true, variantName: true, componentKey: true },
          },
          _count: { select: { collegeSections: true } },
        },
      },
    },
  });

  return templates.map((template) => {
    const collegeSections = template.sections.reduce(
      (sum, slot) => sum + slot._count.collegeSections,
      0,
    );

    return {
      id: template.id,
      name: template.name,
      description: template.description,
      thumbnailUrl: template.thumbnailUrl,
      isPublished: template.isPublished,
      archivedAt: template.archivedAt?.toISOString() ?? null,
      createdAt: template.createdAt.toISOString(),
      createdByEmail: template.createdByEmail,
      colleges: template._count.colleges,
      collegeSections,
      deletable: template._count.colleges === 0 && collegeSections === 0,
      slots: template.sections.map((slot) => ({
        slotId: slot.id,
        sectionType: slot.sectionType,
        order: slot.defaultOrder,
        isRequired: slot.isRequired,
        leadVariantId: slot.defaultVariant?.id ?? null,
        leadVariantName: slot.defaultVariant?.variantName ?? null,
        leadComponentKey: slot.defaultVariant?.componentKey ?? null,
      })),
    };
  });
}

// --- Step 2: one template, and editing its details -----------------------------

/** The library, for the dropdowns the edit screen needs. */
export async function libraryVariantsForAdmin() {
  const rows = await prisma.sectionVariant.findMany({
    orderBy: [
      { sectionType: "asc" },
      { sortOrder: "asc" },
      { variantName: "asc" },
    ],
    select: {
      id: true,
      sectionType: true,
      variantName: true,
      componentKey: true,
      isActive: true,
      createdByEmail: true,
      _count: { select: { collegeSections: true } },
    },
  });

  return rows.map(({ _count, ...variant }) => ({
    ...variant,
    /**
     * Colleges using it.
     *
     * `college_sections.variant_id` is ON DELETE RESTRICT, so this is not merely
     * informational — a non-zero count is why a variant can be retired but never
     * removed.
     */
    inUse: _count.collegeSections,
  }));
}

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
  isPublished: z.boolean().optional(),
  /**
   * Un-archiving, which the addendum has no way to do.
   *
   * Without it, archiving is one-way from the UI: DELETE sets `archivedAt` and
   * nothing ever clears it. A withdrawal that cannot be reversed is a delete
   * wearing a gentler name.
   */
  archived: z.boolean().optional(),
});

/**
 * Edits a template's own fields. Never its composition — that is
 * `updateTemplateSlots`.
 *
 * `name` is unique, so renaming onto an existing one is a constraint violation.
 * Caught here and reported as a 409, rather than reaching `fail()` as an
 * unrecognised error and coming back as a 500 that blames the server.
 */
export async function updateTemplateDetails(
  id: string,
  input: unknown,
  actor: AdminSession,
) {
  const patch = templateDetailsSchema.parse(input);

  const before = await prisma.template.findUnique({
    where: { id },
    select: { name: true, isPublished: true, archivedAt: true },
  });
  if (!before) throw new NotFound("Template not found");

  try {
    await prisma.template.update({
      where: { id },
      data: {
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined
          ? {}
          : { description: patch.description ?? null }),
        ...(patch.isPublished === undefined
          ? {}
          : { isPublished: patch.isPublished }),
        // Re-archiving keeps the original timestamp: when it was withdrawn is a
        // fact, and saving the form again should not rewrite it to now.
        ...(patch.archived === undefined
          ? {}
          : {
              archivedAt: patch.archived
                ? (before.archivedAt ?? new Date())
                : null,
            }),
      },
    });
  } catch (cause) {
    if ((cause as { code?: string }).code === "P2002") {
      throw new AuthError("Another template already has that name", 409);
    }
    throw cause;
  }

  /**
   * Written for somebody reading the log in six months, which is what
   * `AuditLog.summary` asks for. "template.updated" alone does not say what moved.
   */
  const changes: string[] = [];
  if (patch.name !== undefined && patch.name !== before.name) {
    changes.push(`renamed from "${before.name}"`);
  }
  if (
    patch.isPublished !== undefined &&
    patch.isPublished !== before.isPublished
  ) {
    changes.push(patch.isPublished ? "published" : "unpublished");
  }
  if (
    patch.archived !== undefined &&
    patch.archived !== Boolean(before.archivedAt)
  ) {
    changes.push(patch.archived ? "archived" : "un-archived");
  }
  if (patch.description !== undefined) changes.push("description edited");

  await recordAudit({
    actor,
    action: "template.update",
    targetType: "template",
    targetId: id,
    summary: `Template "${patch.name ?? before.name}": ${
      changes.length ? changes.join(", ") : "saved with no changes"
    }`,
    metadata: { changes },
  });

  return getTemplateForAdmin(id);
}

// --- Step 3: which design fills each category ---------------------------------

export const templateSlotsSchema = z.object({
  slots: z
    .array(
      z.object({
        slotId: z.string().min(1),
        /** The library design this slot leads with. Null clears it. */
        leadVariantId: z.string().min(1).nullable().optional(),
        order: z.number().int().min(0).max(999).optional(),
      }),
    )
    .min(1, "Nothing to update"),
});

/**
 * Swaps the design filling a category, and reorders.
 *
 * **An UPDATE, not a replace**, and that is the whole point of it. The addendum
 * does `templateSection.deleteMany` then `createMany`; against this schema that
 * means deleting `sections` rows, and `college_sections` cascades from those — so
 * it would destroy the content of every college on the template, 28 rows for Radian
 * today. There is nothing to delete here: which categories a template offers is
 * fixed by its `sections` rows, and which design fills one is a column on that row.
 *
 * Two checks before any write, both load-bearing:
 *
 *  - the slot must belong to *this* template, or an admin editing Radian could
 *    write to Meridian's row by passing its id
 *  - the design must be an active variant of that slot's own section type, or a
 *    HERO slot could be pointed at a CONTACT component and the registry would
 *    render the wrong shape against content that does not match it
 */
export async function updateTemplateSlots(
  templateId: string,
  input: unknown,
  actor: AdminSession,
) {
  const { slots } = templateSlotsSchema.parse(input);

  const template = await prisma.template.findUnique({
    where: { id: templateId },
    select: {
      name: true,
      sections: { select: { id: true, sectionType: true } },
    },
  });
  if (!template) throw new NotFound("Template not found");

  const owned = new Map(template.sections.map((s) => [s.id, s.sectionType]));

  const wanted = slots
    .map((slot) => slot.leadVariantId)
    .filter((id): id is string => Boolean(id));

  const variants = wanted.length
    ? await prisma.sectionVariant.findMany({
        where: { id: { in: wanted } },
        select: {
          id: true,
          sectionType: true,
          isActive: true,
          variantName: true,
        },
      })
    : [];
  const byId = new Map(variants.map((v) => [v.id, v]));

  for (const slot of slots) {
    const sectionType = owned.get(slot.slotId);
    if (!sectionType) {
      throw new BadRequest("That section does not belong to this template");
    }
    if (!slot.leadVariantId) continue;

    const variant = byId.get(slot.leadVariantId);
    if (!variant) throw new BadRequest("No such design");
    if (!variant.isActive) {
      throw new BadRequest(`"${variant.variantName}" has been retired`);
    }
    if (variant.sectionType !== sectionType) {
      throw new BadRequest(
        `"${variant.variantName}" is a ${variant.sectionType} design and cannot fill a ${sectionType} section`,
      );
    }
  }

  // One transaction, so a rejection partway through cannot leave the template
  // half-swapped.
  await prisma.$transaction(
    slots.map((slot) =>
      prisma.section.update({
        where: { id: slot.slotId },
        data: {
          ...(slot.leadVariantId === undefined
            ? {}
            : { defaultVariantId: slot.leadVariantId }),
          ...(slot.order === undefined ? {} : { defaultOrder: slot.order }),
        },
      }),
    ),
  );

  await recordAudit({
    actor,
    action: "template.slots_update",
    targetType: "template",
    targetId: templateId,
    summary: `Template "${template.name}": ${slots.length} section${
      slots.length === 1 ? "" : "s"
    } re-pointed or reordered`,
    metadata: { slots },
  });

  return getTemplateForAdmin(templateId);
}

// --- Step 4: archive, and delete only when it is genuinely safe ----------------

/**
 * Archives by default; removes the row only when nothing depends on it.
 *
 * The addendum deletes unconditionally. Here `sections` cascades from `templates`
 * and `college_sections` cascades from `sections`, so that call on a template in
 * use destroys every college's content built from it. The schema already states the
 * rule this follows: "A real delete is only offered when no college uses it."
 *
 * `hard` is therefore a request rather than an instruction — honoured when the
 * template has no colleges and no college sections, refused with the count when it
 * does. A confirm() dialog in a browser is not a substitute for the server knowing
 * what it is about to cascade.
 */
export async function retireTemplate(
  id: string,
  options: { hard?: boolean },
  actor: AdminSession,
) {
  const template = await getTemplateForAdmin(id);

  if (!options.hard) {
    await prisma.template.update({
      where: { id },
      data: {
        archivedAt: template.archivedAt
          ? new Date(template.archivedAt)
          : new Date(),
      },
    });

    await recordAudit({
      actor,
      action: "template.archive",
      targetType: "template",
      targetId: id,
      summary: `Archived template "${template.name}" — ${template.colleges} college(s) keep it, it is no longer offered`,
      metadata: {
        colleges: template.colleges,
        collegeSections: template.collegeSections,
      },
    });

    return { archived: true as const, deleted: false as const };
  }

  if (!template.deletable) {
    throw new AuthError(
      `"${template.name}" is used by ${template.colleges} college(s), and ${template.collegeSections} section(s) would be deleted with it. Archive it instead.`,
      409,
    );
  }

  await prisma.template.delete({ where: { id } });

  await recordAudit({
    actor,
    action: "template.delete",
    targetType: "template",
    targetId: id,
    summary: `Deleted template "${template.name}" — it was unused`,
    metadata: { name: template.name },
  });

  return { archived: false as const, deleted: true as const };
}
