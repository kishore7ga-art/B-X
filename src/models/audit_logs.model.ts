import { Schema, model, Document } from "mongoose";

export interface IAuditLog extends Document {
  action: string;
  tenantId: string;
  actorId?: string;
  requestId?: string;
  flowStage?: string;
  actorType?: string;
  ipAddress?: string;
  userAgentHash?: string;
  details?: Record<string, unknown>;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    action: { type: String, required: true, index: true },
    tenantId: { type: String, required: true, index: true },
    actorId: { type: String, required: false },
    requestId: { type: String, required: false, index: true },
    flowStage: { type: String, required: false },
    actorType: { type: String, required: false },
    ipAddress: { type: String, required: false },
    userAgentHash: { type: String, required: false },
    details: { type: Schema.Types.Mixed, required: false },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

export const AuditLog = model<IAuditLog>("AuditLog", auditLogSchema);
