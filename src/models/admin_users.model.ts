import mongoose, { Schema, Document } from "mongoose";

export interface IAdminUser extends Document {
  id: string;
  email: string;
  passwordHash: string;
  totpSecret?: string | null;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

const AdminUserSchema = new Schema<IAdminUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    totpSecret: { type: String, default: null },
    role: { type: String, default: "SUPER_ADMIN" },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: Record<string, any>) => {
        ret.id = ret._id ? ret._id.toString() : ret.id;
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        return ret;
      },
    },
    toObject: {
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

export const AdminUser = mongoose.models.AdminUser || mongoose.model<IAdminUser>("AdminUser", AdminUserSchema);
