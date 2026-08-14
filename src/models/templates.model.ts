import mongoose, { Schema, Document } from "mongoose";

export interface ITemplateSlot {
  slotId: string;
  sectionType: string;
  order: number;
  isRequired: boolean;
  leadVariantId?: string | null;
  leadVariantName?: string | null;
  leadComponentKey?: string | null;
}

export interface ITemplate extends Document {
  id: string;
  name: string;
  category?: string | null;
  description?: string | null;
  thumbnailUrl?: string | null;
  demoUrl?: string | null;
  code?: string | null;
  isPublished: boolean;
  archivedAt?: Date | null;
  createdByEmail?: string | null;
  createdById?: string | null;
  slots: ITemplateSlot[];
  createdAt: Date;
  updatedAt: Date;
}

const TemplateSlotSchema = new Schema<ITemplateSlot>(
  {
    slotId: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    sectionType: { type: String, required: true },
    order: { type: Number, default: 0 },
    isRequired: { type: Boolean, default: false },
    leadVariantId: { type: String, default: null },
    leadVariantName: { type: String, default: null },
    leadComponentKey: { type: String, default: null },
  },
  { _id: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const TemplateSchema = new Schema<ITemplate>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    category: { type: String, default: null },
    description: { type: String, default: null },
    thumbnailUrl: { type: String, default: null },
    demoUrl: { type: String, default: null },
    code: { type: String, default: null },
    isPublished: { type: Boolean, default: false },
    archivedAt: { type: Date, default: null },
    createdByEmail: { type: String, default: null },
    createdById: { type: String, default: null },
    slots: { type: [TemplateSlotSchema], default: [] },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      getters: true,
      transform: (_doc, ret: Record<string, any>) => {
        ret.id = ret._id ? ret._id.toString() : ret.id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
    toObject: {
      virtuals: true,
      getters: true,
      transform: (_doc, ret: Record<string, any>) => {
        ret.id = ret._id ? ret._id.toString() : ret.id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

export const Template = mongoose.models.Template || mongoose.model<ITemplate>("Template", TemplateSchema);
