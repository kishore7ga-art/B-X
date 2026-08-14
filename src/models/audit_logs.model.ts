import { Schema, model, Document } from "mongoose";

export interface IAuditLog extends Document {
  action: string;
  tenantId: string;
  actorId?: string;
  details?: Record<string, unknown>;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    action: { type: String, required: true, index: true },
    tenantId: { type: String, required: true, index: true },
    actorId: { type: String, required: false },
    details: { type: Schema.Types.Mixed, required: false },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

export const AuditLog = model<IAuditLog>("AuditLog", auditLogSchema);
