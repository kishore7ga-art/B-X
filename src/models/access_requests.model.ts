import mongoose, { Schema, Document } from "mongoose";

export interface IAccessRequest extends Document {
  id: string;
  collegeName: string;
  applicantEmail: string;
  applicantName?: string | null;
  /**
   * The applicant's phone number, as they typed it.
   *
   * Stored as given rather than normalised to E.164. This is a number a human
   * rings to check an application is genuine, the extensions and spacing people
   * write are meaningful to them, and a normaliser that guesses a country code
   * wrong turns a reachable number into an unreachable one.
   */
  applicantPhone?: string | null;
  /** The institution's existing website, as typed. May have no scheme. */
  applicantWebsite?: string | null;
  subdomain: string;
  collegeType?: string | null;
  passwordHash?: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  activationToken?: string | null;
  activationTokenExpiresAt?: Date | null;
  reviewedAt?: Date | null;
  reviewedByEmail?: string | null;
  rejectionReason?: string | null;
  createdCollegeId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const AccessRequestSchema = new Schema<IAccessRequest>(
  {
    collegeName: { type: String, required: true, trim: true },
    applicantEmail: { type: String, required: true, lowercase: true, trim: true },
    applicantName: { type: String, default: null },
    applicantPhone: { type: String, default: null },
    applicantWebsite: { type: String, default: null },
    subdomain: { type: String, required: true, lowercase: true, trim: true },
    collegeType: { type: String, default: null },
    passwordHash: { type: String, default: null },
    status: { type: String, enum: ["PENDING", "APPROVED", "REJECTED"], default: "PENDING" },
    activationToken: { type: String, default: null, sparse: true },
    activationTokenExpiresAt: { type: Date, default: null },
    reviewedAt: { type: Date, default: null },
    reviewedByEmail: { type: String, default: null },
    rejectionReason: { type: String, default: null },
    createdCollegeId: { type: String, default: null },
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

/**
 * Both of these are on unauthenticated paths.
 *
 * `login()` reads `{ applicantEmail }` for every failed sign-in, to tell someone
 * waiting in the approval queue why their password is not working; and
 * activation reads `{ activationToken }` on every redemption attempt. Without
 * an index each is a scan of the whole access-request collection, which is the
 * one collection that grows with public traffic.
 */
AccessRequestSchema.index({ applicantEmail: 1, createdAt: -1 });
AccessRequestSchema.index({ activationToken: 1 }, { sparse: true });
AccessRequestSchema.index({ status: 1, createdAt: -1 });

export const AccessRequest = mongoose.models.AccessRequest || mongoose.model<IAccessRequest>("AccessRequest", AccessRequestSchema);
