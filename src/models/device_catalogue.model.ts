import mongoose, { Schema, model, Document } from "mongoose";

/**
 * The widths the editor can preview a site at, and the device tiers they are
 * grouped under.
 *
 * One document, not one row per width. A catalogue is read whole and replaced
 * whole — the editor needs every tier's ladder to cycle through, and an admin
 * editing it works on the list, not on a width — so a single document gives
 * atomic replacement and one `version` to compare against for free. A
 * collection of rows would need a transaction to do either.
 */

export type DeviceIcon = "phone" | "tablet" | "desktop";

export interface IDeviceTier {
  /** Stable id the editor keys its per-tier memory on. `phone`, `tablet`, … */
  id: string;
  label: string;
  /** Which glyph the editor draws. A closed set, because the section CSS
   *  tiers the toolbar writes to are three, and this is the mapping. */
  icon: DeviceIcon;
  order: number;
}

export interface IDevicePreset {
  id: string;
  tierId: string;
  /** CSS pixels the site is laid out against. */
  width: number;
  /** "iPhone 14", "Most common laptop". Blank where the number speaks for itself. */
  note?: string | null;
  /** Where the tier starts when nothing is remembered. At most one per tier. */
  isDefault?: boolean;
}

export interface IDeviceCatalogue extends Document<string> {
  /** Monotonic. Bumped on every replace; clients compare it to skip work. */
  version: number;
  tiers: IDeviceTier[];
  presets: IDevicePreset[];
  updatedBy?: string | null;
  updatedAt: Date;
}

export const DEVICE_CATALOGUE_ID = "device-catalogue";

const tierSchema = new Schema<IDeviceTier>(
  {
    id: { type: String, required: true },
    label: { type: String, required: true },
    icon: { type: String, required: true, enum: ["phone", "tablet", "desktop"] },
    order: { type: Number, required: true },
  },
  { _id: false },
);

const presetSchema = new Schema<IDevicePreset>(
  {
    id: { type: String, required: true },
    tierId: { type: String, required: true },
    width: { type: Number, required: true },
    note: { type: String, default: null },
    isDefault: { type: Boolean, default: false },
  },
  { _id: false },
);

const catalogueSchema = new Schema<IDeviceCatalogue>(
  {
    _id: { type: String, default: DEVICE_CATALOGUE_ID },
    version: { type: Number, required: true, default: 1 },
    tiers: { type: [tierSchema], default: [] },
    presets: { type: [presetSchema], default: [] },
    updatedBy: { type: String, default: null },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);

export const DeviceCatalogue =
  (mongoose.models["DeviceCatalogue"] as mongoose.Model<IDeviceCatalogue>) ||
  model<IDeviceCatalogue>("DeviceCatalogue", catalogueSchema);
