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
  /**
   * The payment provider's order id, when this invoice is one somebody can pay.
   *
   * Added rather than giving one-time payments a collection of their own. An
   * invoice already is "an amount a tenant owes, and whether it is paid" — which
   * is exactly what a Razorpay order is a request to settle. A parallel Order
   * collection would duplicate every field here and leave two answers to "has
   * this been paid", which is the question the whole record exists for.
   */
  providerOrderId?: string | null;
  /** The payment that settled it. A support reference, never card data. */
  providerPaymentId?: string | null;
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
    providerOrderId: { type: String, default: null, trim: true },
    providerPaymentId: { type: String, default: null, trim: true },
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
 * One Razorpay order settles one invoice, and a partial index so the null on
 * every hand-written invoice does not collide with every other null.
 */
InvoiceSchema.index(
  { providerOrderId: 1 },
  { unique: true, partialFilterExpression: { providerOrderId: { $type: "string" } } },
);

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

/**
 * A tenant's subscription, mirroring the one Razorpay holds.
 *
 * Deliberately a mirror and not a second opinion. Razorpay owns the lifecycle —
 * it decides when a subscription becomes active, when a renewal is charged and
 * when a failed payment halts it — and this collection is a local read model
 * kept in step by webhooks. Nothing here ever *decides* that a tenant has paid;
 * it records that Razorpay said so, over a signed channel.
 *
 * `status` uses Razorpay's own vocabulary verbatim rather than a mapped set of
 * our own. A mapping layer here would be a second place for the lifecycle to be
 * described, and the two descriptions would drift the first time Razorpay added
 * a state.
 *
 * The plan is not stored beyond its id. Amount and interval belong to the Plan
 * in the Dashboard, and a copy taken at signup would quietly become wrong the
 * day the price changed.
 */
export type SubscriptionStatus =
  | "created"
  | "authenticated"
  | "active"
  | "pending"
  | "halted"
  | "cancelled"
  | "completed"
  | "expired";

/** The states in which a tenant is entitled to what they paid for. */
export const ENTITLED_STATUSES: readonly SubscriptionStatus[] = ["active", "authenticated"];

/**
 * The states that mean "a subscription already exists, do not start another".
 *
 * Wider than ENTITLED_STATUSES on purpose. `created` is a subscription that has
 * been opened at Razorpay but not yet paid — starting a second one because the
 * first has not completed is exactly the duplicate this guards against. `pending`
 * and `halted` are live subscriptions whose last charge failed; the fix for
 * those is retrying the existing mandate, not selling a new one.
 */
export const OCCUPYING_STATUSES: readonly SubscriptionStatus[] = [
  "created",
  "authenticated",
  "active",
  "pending",
  "halted",
];

export interface ISubscription extends Document {
  id: string;
  /** The college this belongs to. Every query is filtered on it. */
  tenantId: string;
  /** Razorpay's id for the subscription. The join key for every webhook. */
  razorpaySubscriptionId: string;
  razorpayPlanId: string;
  razorpayCustomerId?: string | null;
  status: SubscriptionStatus;
  /** The hosted checkout link Razorpay returns. Useful when the dialog is lost. */
  shortUrl?: string | null;
  currentStart?: Date | null;
  currentEnd?: Date | null;
  endedAt?: Date | null;
  cancelledAt?: Date | null;
  /** Set when a cancellation is scheduled but the paid period has not run out. */
  cancelAtCycleEnd: boolean;
  paidCount: number;
  totalCount: number;
  /** The last payment Razorpay attributed to this subscription, for support. */
  lastPaymentId?: string | null;
  /** When a webhook last moved this row. Null while only checkout has touched it. */
  lastSyncedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const SubscriptionSchema = new Schema<ISubscription>(
  {
    tenantId: { type: String, required: true, index: true },
    razorpaySubscriptionId: { type: String, required: true, unique: true, trim: true },
    razorpayPlanId: { type: String, required: true, trim: true },
    razorpayCustomerId: { type: String, default: null, trim: true },
    status: {
      type: String,
      enum: [
        "created",
        "authenticated",
        "active",
        "pending",
        "halted",
        "cancelled",
        "completed",
        "expired",
      ],
      default: "created",
      index: true,
    },
    shortUrl: { type: String, default: null },
    currentStart: { type: Date, default: null },
    currentEnd: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelAtCycleEnd: { type: Boolean, default: false },
    paidCount: { type: Number, default: 0, min: 0 },
    totalCount: { type: Number, default: 0, min: 0 },
    lastPaymentId: { type: String, default: null, trim: true },
    lastSyncedAt: { type: Date, default: null },
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

/** The only listing there is: this tenant's subscriptions, newest first. */
SubscriptionSchema.index({ tenantId: 1, createdAt: -1 });

/**
 * A Razorpay webhook that has already been handled.
 *
 * Razorpay retries a webhook until it is answered with a 2xx, and will redeliver
 * after a timeout even when the first attempt actually succeeded. Without this,
 * a renewal charged once could be recorded twice, and a cancellation racing a
 * renewal could be applied in either order depending on which retry landed last.
 *
 * Idempotency is the unique index, not a read-then-write: two deliveries
 * arriving concurrently both pass a `findOne` check and both proceed. Inserting
 * first and letting the duplicate-key error stop the second is the only version
 * of this that is safe under concurrency.
 *
 * Rows expire after 30 days. Razorpay stops retrying long before that, and
 * keeping every event forever turns a dedupe table into a log nobody reads.
 */
export interface IWebhookEvent extends Document {
  id: string;
  /** Razorpay's `x-razorpay-event-id` header. Unique per event, stable per retry. */
  eventId: string;
  event: string;
  subscriptionId?: string | null;
  receivedAt: Date;
}

const WebhookEventSchema = new Schema<IWebhookEvent>({
  eventId: { type: String, required: true, unique: true, trim: true },
  event: { type: String, required: true, trim: true },
  subscriptionId: { type: String, default: null, trim: true },
  receivedAt: { type: Date, required: true, default: Date.now },
});

WebhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const Invoice =
  mongoose.models.Invoice || mongoose.model<IInvoice>("Invoice", InvoiceSchema);
export const Subscription =
  mongoose.models.Subscription ||
  mongoose.model<ISubscription>("Subscription", SubscriptionSchema);
export const WebhookEvent =
  mongoose.models.WebhookEvent ||
  mongoose.model<IWebhookEvent>("WebhookEvent", WebhookEventSchema);
export const PaymentMethod =
  mongoose.models.PaymentMethod ||
  mongoose.model<IPaymentMethod>("PaymentMethod", PaymentMethodSchema);
