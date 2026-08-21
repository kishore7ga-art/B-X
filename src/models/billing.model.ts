import mongoose, { Schema, Document } from "mongoose";

/**
 * Billing records.
 *
 * The settings screen showed three invoices — INV-2026-089, INV-2025-088,
 * INV-2024-042, all "Paid" — as literals in the JSX, identical for every
 * tenant, and a saved card ending 4242 that belonged to nobody. These
 * collections replace that with rows that exist.
 *
 * What they deliberately are not: a billing engine. Nothing in this platform
 * prices a plan, meters usage, raises an invoice or takes a payment, and none
 * of that is invented here. Invoices are written by a Super Admin, and payment
 * methods are references to a card held by a payment provider — of which none
 * is currently integrated. Both surfaces report emptiness honestly rather than
 * showing a plausible history.
 */

export type InvoiceStatus = "PAID" | "DUE" | "OVERDUE" | "VOID" | "REFUNDED";

export interface IInvoice extends Document {
  id: string;
  /** The college this belongs to. Every query is filtered on it. */
  tenantId: string;
  /** Human-facing reference, unique across the platform. */
  number: string;
  description: string;
  /** Minor units — paise, cents. Never a float: 0.1 + 0.2 is not 0.3. */
  amountMinor: number;
  currency: string;
  status: InvoiceStatus;
  issuedAt: Date;
  dueAt?: Date | null;
  paidAt?: Date | null;
  /** Where the tenant can fetch a PDF, when a provider supplies one. */
  documentUrl?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const InvoiceSchema = new Schema<IInvoice>(
  {
    tenantId: { type: String, required: true, index: true },
    number: { type: String, required: true, unique: true, trim: true },
    description: { type: String, required: true, trim: true },
    amountMinor: { type: Number, required: true, min: 0 },
    currency: { type: String, required: true, default: "INR", uppercase: true, trim: true },
    status: {
      type: String,
      enum: ["PAID", "DUE", "OVERDUE", "VOID", "REFUNDED"],
      default: "DUE",
      index: true,
    },
    issuedAt: { type: Date, required: true, default: Date.now },
    dueAt: { type: Date, default: null },
    paidAt: { type: Date, default: null },
    documentUrl: { type: String, default: null },
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

/** Newest first, per tenant — the only way this is ever listed. */
InvoiceSchema.index({ tenantId: 1, issuedAt: -1 });

/**
 * A card, as far as this platform is ever allowed to know it.
 *
 * There is no field here for a card number, an expiry beyond the month and year
 * printed on a statement, or a CVC — and there must never be one. Storing a PAN
 * puts this system in PCI-DSS scope, and storing a CVC after authorisation is
 * prohibited outright. The settings screen previously held all three in React
 * state and rendered them into inputs.
 *
 * What is stored is a reference: which provider holds the card, the opaque id
 * that provider gave us, and the brand and last four digits, which exist purely
 * so a person can tell two of their own cards apart.
 */
export interface IPaymentMethod extends Document {
  id: string;
  tenantId: string;
  /** "stripe", "razorpay", … Whatever actually holds the instrument. */
  provider: string;
  /** The provider's own id for it. Meaningless outside that provider. */
  providerRef: string;
  brand?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PaymentMethodSchema = new Schema<IPaymentMethod>(
  {
    tenantId: { type: String, required: true, index: true },
    provider: { type: String, required: true, trim: true, lowercase: true },
    providerRef: { type: String, required: true, trim: true },
    brand: { type: String, default: null, trim: true },
    // Four characters, and a regex that will not accept anything longer. This
    // is the one place a mistake would turn a display detail into card data.
    last4: { type: String, default: null, match: /^[0-9]{4}$/ },
    expMonth: { type: Number, default: null, min: 1, max: 12 },
    expYear: { type: Number, default: null, min: 2000, max: 2100 },
    isDefault: { type: Boolean, default: false },
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

/** One provider reference cannot be attached twice. */
PaymentMethodSchema.index({ provider: 1, providerRef: 1 }, { unique: true });

export const Invoice =
  mongoose.models.Invoice || mongoose.model<IInvoice>("Invoice", InvoiceSchema);
export const PaymentMethod =
  mongoose.models.PaymentMethod ||
  mongoose.model<IPaymentMethod>("PaymentMethod", PaymentMethodSchema);
