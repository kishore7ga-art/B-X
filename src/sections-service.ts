import { z } from "zod";

import { prisma } from "@/db";
import { stableStringify } from "@/lib/json-stable";
import {
  isSupportedSectionType,
  parseSectionContent,
} from "@/lib/sections/schemas";

const SAVE_TRIGGERS = [
  "typing",
  "drag",
  "color",
  "font",
  "image",
  "delete",
  "resize",
  "section_update",
  "restore",
] as const;

/**
 * Snapshots kept per section. Bounded on insert rather than swept on a
 * schedule: a cron that has not run yet is not a retention policy, and a
 * two-second debounce writes history faster than anyone reads it.
 */
const RETAINED_VERSIONS = 50;

export const saveSchema = z.object({
  content: z.unknown(),
  trigger: z.enum(SAVE_TRIGGERS).default("typing"),
});

/** Loads a section, refusing anything outside the caller's college. */
async function loadOwned(id: string, collegeId: string) {
  const row = await prisma.collegeSection.findFirst({
    where: { id, collegeId },
    include: { section: true },
  });
  if (!row) throw new NotFound("Section not found for this college");
  return row;
}

export class NotFound extends Error {}

export async function saveContent(
  id: string,
  collegeId: string,
  input: z.infer<typeof saveSchema>,
) {
  const row = await loadOwned(id, collegeId);

  if (!isSupportedSectionType(row.section.sectionType)) {
    throw new Error("Section type is not editable");
  }

  const parsed = parseSectionContent(row.section.sectionType, input.content);

  // Postgres reorders jsonb keys on storage, so a byte-identical payload never
  // compares equal without normalising first — every no-op save would file an
  // identical snapshot and bury the versions that differ.
  const changed =
    stableStringify(parsed) !== stableStringify(row.content ?? null);

  const savedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.collegeSection.update({
      where: { id: row.id },
      data: { content: parsed as never, lastSavedAt: savedAt },
    });

    if (!changed) return;

    await tx.collegeSectionHistory.create({
      data: {
        collegeSectionId: row.id,
        contentSnapshot: parsed as never,
        saveTrigger: input.trigger,
        savedAt,
      },
    });

    const stale = await tx.collegeSectionHistory.findMany({
      where: { collegeSectionId: row.id },
      orderBy: { savedAt: "desc" },
      skip: RETAINED_VERSIONS,
      select: { id: true },
    });
    if (stale.length) {
      await tx.collegeSectionHistory.deleteMany({
        where: { id: { in: stale.map((s) => s.id) } },
      });
    }
  });

  return { savedAt: savedAt.toISOString() };
}

export async function listHistory(id: string, collegeId: string) {
  const row = await loadOwned(id, collegeId);

  const versions = await prisma.collegeSectionHistory.findMany({
    where: { collegeSectionId: row.id },
    orderBy: { savedAt: "desc" },
    select: {
      id: true,
      savedAt: true,
      saveTrigger: true,
      contentSnapshot: true,
    },
  });

  const live = stableStringify(row.content ?? null);

  return versions.map((version) => ({
    id: version.id,
    savedAt: version.savedAt.toISOString(),
    saveTrigger: version.saveTrigger,
    isCurrent: stableStringify(version.contentSnapshot) === live,
  }));
}

/** Restoring is itself a save, so it lands in history and can be undone. */
export async function restoreVersion(
  id: string,
  collegeId: string,
  versionId: string,
) {
  const row = await loadOwned(id, collegeId);

  const version = await prisma.collegeSectionHistory.findFirst({
    // Scoped to this section, so a known id from another college is useless.
    where: { id: versionId, collegeSectionId: row.id },
  });
  if (!version) throw new NotFound("That version no longer exists");

  return saveContent(id, collegeId, {
    content: version.contentSnapshot,
    trigger: "restore",
  });
}
