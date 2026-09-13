import bcrypt from "bcryptjs";

import { AuditLog, College, Invoice, PaymentMethod } from "@/models";
import type { ICollege } from "@/models/colleges.model";
import { razorpayConfigured } from "@/razorpay";

/**
 * Account settings: password, billing history, payment methods.
 *
 * All three were forms that submitted nowhere. The password card compared two
 * fields in React and showed a toast; the billing table was three invoice
 * numbers written into the JSX; the payment card was a `useState` holding
 * "•••• •••• •••• 4242" and a CVC.
 */

/** Minimum that will be accepted for a new password. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Which payment provider is wired up, if any.
 *
 * Razorpay, when it is configured — and that is decided by asking Razorpay's own
 * module whether it has a key, a secret and a plan, not by reading a second
 * environment variable that says so.
 *
 * `PAYMENT_PROVIDER` used to be that second variable, and it was the whole
 * answer back when no provider existed at all. Keeping it as the switch now
 * would mean a deployment could set `PAYMENT_PROVIDER=razorpay` with no keys and
 * have this report a gateway that cannot take money, or configure Razorpay
 * properly and have this report none because a second variable was missed. Both
 * failures are silent and both show up on a different screen from the cause.
 *
 * It is still honoured for a provider this service does not implement, so that
 * naming one keeps reporting null rather than becoming a claim.
 */
export function paymentProvider(): string | null {
  if (razorpayConfigured()) return "razorpay";

  const configured = process.env.PAYMENT_PROVIDER?.trim().toLowerCase();
  if (!configured) return null;

  /*
   * Named but unimplemented is worse than absent: it would let a UI open a flow
   * this service cannot finish. Razorpay is excluded here deliberately — if it
   * were genuinely configured the check above would already have returned, so
   * reaching this line with "razorpay" means the keys are missing.
   */
  return configured === "stripe" ? configured : null;
}

/**
 * Changes a college user's password.
 *
 * The current password is required and verified, so possession of an unlocked
 * browser tab is not on its own enough to lock the real owner out. The user is
 * resolved from the session, never from the request body.
 */
export async function changePassword(
  collegeId: string,
  userId: string,
  input: unknown,
  actorEmail: string | null,
): Promise<void> {
  const body = (input ?? {}) as { currentPassword?: unknown; newPassword?: unknown };

  if (typeof body.currentPassword !== "string" || !body.currentPassword) {
    throw Object.assign(new Error("Enter your current password."), { status: 400 });
  }
  if (typeof body.newPassword !== "string" || !body.newPassword) {
    throw Object.assign(new Error("Enter a new password."), { status: 400 });
  }
  if (body.newPassword.length < MIN_PASSWORD_LENGTH) {
    throw Object.assign(
      new Error(`Use at least ${MIN_PASSWORD_LENGTH} characters.`),
      { status: 400 },
    );
  }
  if (body.newPassword === body.currentPassword) {
    throw Object.assign(new Error("The new password must be different."), { status: 400 });
  }

  const college = (await College.findById(collegeId)) as ICollege | null;
  if (!college) throw Object.assign(new Error("College not found"), { status: 404 });

  const user = (college.users ?? []).find((candidate) => candidate.id === userId);
  if (!user) {
    throw Object.assign(new Error("Sign in again to change your password."), { status: 401 });
  }

  const matches = await bcrypt.compare(body.currentPassword, user.passwordHash);
  if (!matches) {
    // Recorded: repeated failures here are the signal that somebody is trying
    // passwords against a session they should not have.
    await AuditLog.create({
      action: "PASSWORD_CHANGE_FAILED",
      tenantId: collegeId,
      details: { actor: actorEmail, reason: "current password incorrect" },
    }).catch(() => null);

    throw Object.assign(new Error("That current password is not correct."), { status: 400 });
  }

  const passwordHash = await bcrypt.hash(body.newPassword, 12);

  await College.updateOne(
    { _id: collegeId, "users.id": userId },
    { $set: { "users.$.passwordHash": passwordHash } },
  );

  await AuditLog.create({
    action: "PASSWORD_CHANGED",
    tenantId: collegeId,
    details: { actor: actorEmail },
  }).catch(() => null);
}

export type InvoiceView = {
  id: string;
  number: string;
  description: string;
  amountMinor: number;
  currency: string;
  /** Formatted for display, so every surface agrees on where the decimal goes. */
  amountDisplay: string;
  status: string;
  issuedAt: Date;
  dueAt: Date | null;
  paidAt: Date | null;
  documentUrl: string | null;
};

function formatAmount(amountMinor: number, currency: string): string {
  const major = amountMinor / 100;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(major);
  } catch {
    // An unknown currency code should not take the billing page down.
    return `${currency} ${major.toFixed(2)}`;
  }
}

/** This tenant's invoices, newest first. Scoped by `tenantId` in the query. */
export async function listInvoices(collegeId: string): Promise<InvoiceView[]> {
  const rows = await Invoice.find({ tenantId: collegeId }).sort({ issuedAt: -1 }).limit(100).lean();

  return rows.map((row: any) => ({
    id: String(row._id),
    number: row.number,
    description: row.description,
    amountMinor: row.amountMinor,
    currency: row.currency,
    amountDisplay: formatAmount(row.amountMinor, row.currency),
    status: row.status,
    issuedAt: row.issuedAt,
    dueAt: row.dueAt ?? null,
    paidAt: row.paidAt ?? null,
    documentUrl: row.documentUrl ?? null,
  }));
}

export type PaymentMethodView = {
  id: string;
  provider: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
};

export async function listPaymentMethods(collegeId: string): Promise<PaymentMethodView[]> {
  const rows = await PaymentMethod.find({ tenantId: collegeId })
    .sort({ isDefault: -1, createdAt: -1 })
    .lean();

  return rows.map((row: any) => ({
    id: String(row._id),
    provider: row.provider,
    brand: row.brand ?? null,
    last4: row.last4 ?? null,
    expMonth: row.expMonth ?? null,
    expYear: row.expYear ?? null,
    isDefault: Boolean(row.isDefault),
  }));
}

/**
 * Attaches a card that a payment provider has already tokenised.
 *
 * The body carries a provider reference and display metadata — never a card
 * number, an expiry date typed into this platform, or a CVC. Anything that
 * looks like a PAN is refused rather than trimmed, because silently accepting
 * it and storing "the safe parts" is how a PAN ends up in a log line.
 *
 * **Razorpay subscriptions do not use this.** The mandate is set up inside
 * Razorpay Checkout, against the subscription, and the instrument is held
 * there — this platform never handles it and has nothing to attach. The
 * settings screen accordingly shows what Razorpay holds rather than offering a
 * form; see `paymentInstrument` in subscription-service.ts.
 *
 * It is kept for a provider whose flow genuinely is "tokenise elsewhere, then
 * register the token here", and it still refuses a PAN under any provider.
 */
export async function attachPaymentMethod(
  collegeId: string,
  input: unknown,
  actorEmail: string | null,
): Promise<PaymentMethodView> {
  const provider = paymentProvider();
  if (!provider) {
    throw Object.assign(
      new Error(
        "No payment provider is connected to this platform yet, so a card cannot be saved.",
      ),
      { status: 501 },
    );
  }

  const body = (input ?? {}) as Record<string, unknown>;

  for (const forbidden of ["number", "cardNumber", "pan", "cvc", "cvv", "securityCode"]) {
    if (body[forbidden] !== undefined) {
      throw Object.assign(
        new Error(
          "Card details must be sent to the payment provider, never to XITE. Send the provider's token instead.",
        ),
        { status: 400 },
      );
    }
  }

  const providerRef = typeof body.providerRef === "string" ? body.providerRef.trim() : "";
  if (!providerRef) {
    throw Object.assign(new Error("A provider reference is required."), { status: 400 });
  }

  const last4 = typeof body.last4 === "string" && /^[0-9]{4}$/.test(body.last4) ? body.last4 : null;
  const existing = await PaymentMethod.countDocuments({ tenantId: collegeId });

  const created = await PaymentMethod.create({
    tenantId: collegeId,
    provider,
    providerRef,
    brand: typeof body.brand === "string" ? body.brand.slice(0, 32) : null,
    last4,
    expMonth: Number.isInteger(body.expMonth) ? (body.expMonth as number) : null,
    expYear: Number.isInteger(body.expYear) ? (body.expYear as number) : null,
    // The first card a tenant attaches is their default; nothing else would be.
    isDefault: existing === 0,
  });

  await AuditLog.create({
    action: "PAYMENT_METHOD_ATTACHED",
    tenantId: collegeId,
    details: { provider, last4, actor: actorEmail },
  }).catch(() => null);

  return {
    id: String(created._id),
    provider: created.provider,
    brand: created.brand ?? null,
    last4: created.last4 ?? null,
    expMonth: created.expMonth ?? null,
    expYear: created.expYear ?? null,
    isDefault: created.isDefault,
  };
}

/** Removes a card reference. Scoped by tenant, so another tenant's id is simply not found. */
export async function detachPaymentMethod(
  collegeId: string,
  methodId: string,
  actorEmail: string | null,
): Promise<void> {
  const row = await PaymentMethod.findOne({ _id: methodId, tenantId: collegeId }).lean();
  if (!row) throw Object.assign(new Error("Payment method not found"), { status: 404 });

  await PaymentMethod.deleteOne({ _id: methodId, tenantId: collegeId });

  // Losing the default must not leave a tenant with cards and no default.
  const remaining = await PaymentMethod.findOne({ tenantId: collegeId }).sort({ createdAt: 1 });
  if (remaining && !remaining.isDefault) {
    remaining.isDefault = true;
    await remaining.save();
  }

  await AuditLog.create({
    action: "PAYMENT_METHOD_DETACHED",
    tenantId: collegeId,
    details: { provider: (row as any).provider, actor: actorEmail },
  }).catch(() => null);
}

export const __testing = { formatAmount };
