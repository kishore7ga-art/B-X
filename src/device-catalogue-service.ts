import { z } from "zod";

import { AuditLog } from "@/models";
import {
  DEVICE_CATALOGUE_ID,
  DeviceCatalogue,
  type IDeviceCatalogue,
  type IDevicePreset,
  type IDeviceTier,
} from "@/models/device_catalogue.model";
import { BadRequest } from "@/errors";

/**
 * The preview widths the editor offers, and the tiers they cycle within.
 *
 * ── Why this lives here and not in the frontend ───────────────────────────
 *
 * The editor used to carry thirty widths as constants. Every new phone, every
 * "can we add 1600?", was a frontend release. The list is data: it changes on
 * its own schedule, it is the same for every tenant, and an admin should be
 * able to change it without a deploy. So the frontend now carries no widths
 * at all — it asks for this catalogue, groups it by tier at runtime, and
 * cycles through whatever it was given.
 *
 * ── The contract ──────────────────────────────────────────────────────────
 *
 *   {
 *     version:  number      // monotonic; bumped on every replace
 *     updatedAt: string     // ISO
 *     tiers:   [{ id, label, icon: "phone"|"tablet"|"desktop", order }]
 *     presets: [{ id, tierId, width, note?, isDefault? }]
 *   }
 *
 * Tiers are data too, but their `icon` is a closed set: the editor draws one
 * of three glyphs, and the section toolbar writes CSS to one of three tiers,
 * and `icon` is the mapping between a tier somebody named and those three.
 * A tier with no presets is legal and is served as such — the editor shows
 * the tier disabled rather than the catalogue failing to load.
 *
 * `presets` are served sorted by (tier order, width), so a client that wants
 * the ladder as the admin sees it need not sort. The ordering rule is here,
 * where it is enforced, rather than in every client.
 */

export type DeviceCatalogueView = {
  version: number;
  updatedAt: string;
  tiers: IDeviceTier[];
  presets: IDevicePreset[];
};

export const MIN_WIDTH = 200;
export const MAX_WIDTH = 7680;
export const MAX_TIERS = 12;
export const MAX_PRESETS = 500;

const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

const tierSchema = z.object({
  id: z.string().regex(ID, "A tier id is lowercase letters, digits and dashes."),
  label: z.string().trim().min(1).max(40),
  icon: z.enum(["phone", "tablet", "desktop"]),
  order: z.number().int().min(0).max(1000),
});

const presetSchema = z.object({
  id: z.string().regex(ID, "A preset id is lowercase letters, digits and dashes.").optional(),
  tierId: z.string().regex(ID),
  width: z.number().int().min(MIN_WIDTH).max(MAX_WIDTH),
  note: z.string().trim().max(60).nullable().optional(),
  isDefault: z.boolean().optional(),
});

export const catalogueInputSchema = z.object({
  tiers: z.array(tierSchema).min(1).max(MAX_TIERS),
  presets: z.array(presetSchema).max(MAX_PRESETS),
});

export type CatalogueInput = z.infer<typeof catalogueInputSchema>;

/**
 * What a fresh deployment starts with. The same thirty widths the editor
 * carried as constants, so nothing changes for anyone on the day this ships;
 * from then on the database is the source and this is never consulted again.
 */
export const DEFAULT_CATALOGUE: CatalogueInput = {
  tiers: [
    { id: "desktop", label: "Desktop", icon: "desktop", order: 0 },
    { id: "tablet", label: "Tablet", icon: "tablet", order: 1 },
    { id: "phone", label: "Phone", icon: "phone", order: 2 },
  ],
  presets: [
    { tierId: "desktop", width: 1024, note: "Small laptop" },
    { tierId: "desktop", width: 1280 },
    { tierId: "desktop", width: 1366, note: "Most common laptop" },
    { tierId: "desktop", width: 1440, note: "Default", isDefault: true },
    { tierId: "desktop", width: 1536 },
    { tierId: "desktop", width: 1600 },
    { tierId: "desktop", width: 1920, note: "Full HD" },
    { tierId: "desktop", width: 2560, note: "QHD" },
    { tierId: "desktop", width: 2880 },
    { tierId: "desktop", width: 3840, note: "4K" },
    { tierId: "tablet", width: 600 },
    { tierId: "tablet", width: 640 },
    { tierId: "tablet", width: 667 },
    { tierId: "tablet", width: 720 },
    { tierId: "tablet", width: 768, note: "iPad portrait", isDefault: true },
    { tierId: "tablet", width: 800 },
    { tierId: "tablet", width: 834, note: "iPad Air" },
    { tierId: "tablet", width: 900 },
    { tierId: "tablet", width: 960 },
    { tierId: "tablet", width: 1024, note: "iPad landscape" },
    { tierId: "phone", width: 320, note: "iPhone SE (1st gen)" },
    { tierId: "phone", width: 360, note: "Most common Android" },
    { tierId: "phone", width: 375, note: "iPhone SE / 8" },
    { tierId: "phone", width: 390, note: "iPhone 14", isDefault: true },
    { tierId: "phone", width: 393, note: "Pixel 7" },
    { tierId: "phone", width: 412, note: "Pixel 7 Pro" },
    { tierId: "phone", width: 414, note: "iPhone Plus" },
    { tierId: "phone", width: 430, note: "iPhone Pro Max" },
    { tierId: "phone", width: 480 },
    { tierId: "phone", width: 540 },
  ],
};

/**
 * Validates and normalises an input catalogue into what is stored.
 *
 * Beyond the schema: tier ids unique, every preset's tier exists, no two
 * presets share a (tier, width), at most one default per tier — and a tier
 * with presets but no default gets one, its smallest width, so the editor
 * always has somewhere to start. Presets are given ids where missing and the
 * whole thing is sorted, so what is stored is already what is served.
 */
export function normaliseCatalogue(input: unknown): { tiers: IDeviceTier[]; presets: IDevicePreset[] } {
  const parsed = catalogueInputSchema.parse(input);

  const tierIds = new Set<string>();
  for (const tier of parsed.tiers) {
    if (tierIds.has(tier.id)) throw new BadRequest(`Tier "${tier.id}" appears twice.`);
    tierIds.add(tier.id);
  }
  const tiers = [...parsed.tiers].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const tierOrder = new Map(tiers.map((t, i) => [t.id, i]));

  const seenWidth = new Set<string>();
  const seenId = new Set<string>();
  const defaultFor = new Map<string, number>();
  const presets: IDevicePreset[] = parsed.presets.map((preset) => {
    if (!tierIds.has(preset.tierId)) {
      throw new BadRequest(`Preset ${preset.width}px names a tier "${preset.tierId}" that does not exist.`);
    }
    const widthKey = `${preset.tierId}:${preset.width}`;
    if (seenWidth.has(widthKey)) throw new BadRequest(`${preset.width}px appears twice under "${preset.tierId}".`);
    seenWidth.add(widthKey);

    const id = preset.id ?? `${preset.tierId}-${preset.width}`;
    if (seenId.has(id)) throw new BadRequest(`Preset id "${id}" appears twice.`);
    seenId.add(id);

    if (preset.isDefault) {
      if (defaultFor.has(preset.tierId)) {
        throw new BadRequest(`Tier "${preset.tierId}" has more than one default width.`);
      }
      defaultFor.set(preset.tierId, preset.width);
    }
    return {
      id,
      tierId: preset.tierId,
      width: preset.width,
      note: preset.note?.trim() || null,
      isDefault: Boolean(preset.isDefault),
    };
  });

  presets.sort(
    (a, b) => (tierOrder.get(a.tierId) ?? 0) - (tierOrder.get(b.tierId) ?? 0) || a.width - b.width,
  );

  // A tier that has widths but no default starts at its smallest.
  for (const tier of tiers) {
    if (defaultFor.has(tier.id)) continue;
    const first = presets.find((p) => p.tierId === tier.id);
    if (first) first.isDefault = true;
  }

  return { tiers, presets };
}

function toView(doc: Pick<IDeviceCatalogue, "version" | "tiers" | "presets" | "updatedAt">): DeviceCatalogueView {
  return {
    version: doc.version,
    updatedAt: (doc.updatedAt ?? new Date()).toISOString(),
    tiers: doc.tiers.map((t) => ({ id: t.id, label: t.label, icon: t.icon, order: t.order })),
    presets: doc.presets.map((p) => ({
      id: p.id,
      tierId: p.tierId,
      width: p.width,
      note: p.note ?? null,
      isDefault: Boolean(p.isDefault),
    })),
  };
}

/** The catalogue, seeded on first read so there is never an empty answer. */
export async function getDeviceCatalogue(): Promise<DeviceCatalogueView> {
  const existing = await DeviceCatalogue.findById(DEVICE_CATALOGUE_ID).lean();
  if (existing) return toView(existing as unknown as IDeviceCatalogue);

  const seeded = normaliseCatalogue(DEFAULT_CATALOGUE);
  const created = await DeviceCatalogue.findOneAndUpdate(
    { _id: DEVICE_CATALOGUE_ID },
    { $setOnInsert: { ...seeded, version: 1 } },
    { upsert: true, new: true },
  ).lean();
  return toView(created as unknown as IDeviceCatalogue);
}

/** Replaces the catalogue whole. Admin only; the caller has checked. */
export async function replaceDeviceCatalogue(input: unknown, actorEmail: string): Promise<DeviceCatalogueView> {
  const next = normaliseCatalogue(input);
  const updated = await DeviceCatalogue.findOneAndUpdate(
    { _id: DEVICE_CATALOGUE_ID },
    { $set: { ...next, updatedBy: actorEmail }, $inc: { version: 1 } },
    { upsert: true, new: true },
  ).lean();

  await AuditLog.create({
    action: "DEVICE_CATALOGUE_UPDATED",
    tenantId: "platform",
    details: { actor: actorEmail, tiers: next.tiers.length, presets: next.presets.length },
  }).catch(() => null);

  return toView(updated as unknown as IDeviceCatalogue);
}
