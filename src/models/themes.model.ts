import mongoose, { Schema, Document } from "mongoose";

export interface IThemePalette extends Document {
  id: string;
  name: string;
  paletteColors: Record<string, any>;
  createdAt: Date;
}

export interface IThemeFont extends Document {
  id: string;
  name: string;
  headingFont?: string | null;
  bodyFont?: string | null;
  createdAt: Date;
}

const ThemePaletteSchema = new Schema<IThemePalette>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    paletteColors: { type: Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: Record<string, any>) => {
        ret.id = ret._id ? ret._id.toString() : ret.id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

const ThemeFontSchema = new Schema<IThemeFont>(
  {
    name: { type: String, required: true, unique: true, trim: true },
    headingFont: { type: String, default: null },
    bodyFont: { type: String, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: Record<string, any>) => {
        ret.id = ret._id ? ret._id.toString() : ret.id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

export const ThemePalette = mongoose.models.ThemePalette || mongoose.model<IThemePalette>("ThemePalette", ThemePaletteSchema);
export const ThemeFont = mongoose.models.ThemeFont || mongoose.model<IThemeFont>("ThemeFont", ThemeFontSchema);
