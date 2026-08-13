import mongoose, { Schema, Document } from "mongoose";

export interface ICollegeUser {
  id: string;
  email: string;
  passwordHash: string;
  status: "ACTIVE" | "DISABLED";
  createdAt: Date;
}

export interface ISectionItem {
  id: string;
  title?: string;
  sectionType?: string;
  category?: string;
  code?: string;
  sortOrder?: number;
  variantIndex?: number;
  [key: string]: any;
}

export interface IPageItem {
  slug: string;
  title: string;
  sections: ISectionItem[];
}

export interface IWebsiteConfig {
  pages: IPageItem[];
}

export interface ICollege extends Document {
  id: string;
  name: string;
  subdomain: string;
  customDomain?: string | null;
  templateId?: string | null;
  themePaletteId?: string | null;
  themeFontId?: string | null;
  status: "DRAFT" | "PENDING" | "ACTIVE" | "DISABLED";
  adoptable: boolean;
  collegeType?: string | null;
  isDemo: boolean;
  users: ICollegeUser[];
  websiteConfig?: IWebsiteConfig | null;
  createdAt: Date;
  updatedAt: Date;
}

const CollegeUserSchema = new Schema<ICollegeUser>(
  {
    id: { type: String, required: true, default: () => new mongoose.Types.ObjectId().toString() },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    status: { type: String, enum: ["ACTIVE", "DISABLED"], default: "ACTIVE" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const SectionItemSchema = new Schema<ISectionItem>(
  {
    id: { type: String, default: () => new mongoose.Types.ObjectId().toString() },
    title: { type: String, default: "Section" },
    sectionType: { type: String, default: "hero" },
    category: { type: String },
    code: { type: String, default: "" },
    sortOrder: { type: Number, default: 0 },
    variantIndex: { type: Number, default: 0 },
  },
  { _id: false, strict: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const PageItemSchema = new Schema<IPageItem>(
  {
    slug: { type: String, required: true },
    title: { type: String, required: true },
    sections: { type: [SectionItemSchema], default: [] },
  },
  { _id: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const WebsiteConfigSchema = new Schema<IWebsiteConfig>(
  {
    pages: { type: [PageItemSchema], default: [] },
  },
  { _id: false, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

const CollegeSchema = new Schema<ICollege>(
  {
    name: { type: String, required: true, trim: true },
    subdomain: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    customDomain: { type: String, sparse: true, unique: true, lowercase: true, trim: true, default: undefined },
    templateId: { type: String, default: null },
    themePaletteId: { type: String, default: null },
    themeFontId: { type: String, default: null },
    status: { type: String, enum: ["DRAFT", "PENDING", "ACTIVE", "DISABLED"], default: "DRAFT" },
    adoptable: { type: Boolean, default: true },
    collegeType: { type: String, default: null },
    isDemo: { type: Boolean, default: false },
    users: { type: [CollegeUserSchema], default: [] },
    websiteConfig: { type: WebsiteConfigSchema, default: null },
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

export const College = mongoose.models.College || mongoose.model<ICollege>("College", CollegeSchema);
