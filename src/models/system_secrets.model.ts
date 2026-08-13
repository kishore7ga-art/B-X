import mongoose, { Schema, Document } from "mongoose";

export interface ISystemSecret extends Document {
  id: string;
  name: string;
  value: any;
  createdAt: Date;
  updatedAt: Date;
}

const SystemSecretSchema = new Schema<ISystemSecret>(
  {
    name: { type: String, required: true, unique: true, index: true },
    value: { type: Schema.Types.Mixed, required: true },
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

export const SystemSecret = mongoose.models.SystemSecret || mongoose.model<ISystemSecret>("SystemSecret", SystemSecretSchema);
