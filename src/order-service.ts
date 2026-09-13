import { randomUUID } from "node:crypto";

import { AuditLog, Invoice } from "@/models";
import type { IInvoice } from "@/models/billing.model";
import { BadRequest, NotFound } from "@/errors";
import {
  createOrder as createAtRazorpay,
  fetchOrder,
  isTestMode,
  keyId,
  MIN_AMOUNT_MINOR,
  orderPaymentSignatureValid,
  razorpayConfigured,
} from "@/razorpay";

/**
 * One-time payments, on Razorpay Orders.
 *
 * This sits beside subscription-service.ts rather than replacing it, because
 * the two are different products at Razorpay and not two spellings of one. A
 * subscription renews on a mandate and takes its price from a Plan; an order is
 * charged once and carries its own amount. The signatures differ too, in the
 * one way most likely to be got wrong — see `orderPaymentSignatureValid`.
 *
 * The same rule governs both files: **Razorpay decides, this records.** An
 * order is marked paid only after a signature computed with the key secret
 * matches, and then only after Razorpay's own copy of the order confirms it.
 *
 * There is no Order collection. A one-time payment is recorded as an `Invoice`,
 * which already means "an amount a tenant owes, and whether it is paid" — the
 * exact thing an order is a request to settle. A parallel collection would
 * duplicate every field and leave two answers to the only question the record
 * exists to answer.
 */

/** The currency orders are raised in. */
function currency(): string {
  return (process.env.RAZORPAY_CURRENCY || "INR").trim().toUpperCase();
}

/**
 * What a one-time payment costs, in paise.
 *
 * Deliberately has no default. Every other configurable in this service can
 * fall back to something sensible; an amount cannot, because the fallback is a
 * sum of money nobody chose being charged to somebody's card. An unset value
 * makes the endpoint report itself unconfigured, exactly as a missing key does.
 */
function amountMinor(): number | null {
  const raw = Number(process.env.RAZORPAY_AMOUNT_MINOR ?? "");
  if (!Number.isInteger(raw) || raw < MIN_AMOUNT_MINOR) return null;
  return raw;
}

export type OrderView = {
  /** The invoice this order settles. */
  invoiceId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  status: string;
  paid: boolean;
};

export type OrderCheckout = {
  order: OrderView;
  /** Razorpay's publishable key. The secret never appears in any response. */
  keyId: string;
  testMode: boolean;
};

function view(row: IInvoice): OrderView {
  return {
    invoiceId: String(row._id),
    orderId: row.providerOrderId ?? "",
    amountMinor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    paid: row.status === "PAID",
  };
}

/** Whether one-time payments can be taken at all on this deployment. */
export function ordersConfigured(): boolean {
  // The plan id is not required here — an order carries its own amount — so
  // this is deliberately a weaker test than `razorpayConfigured()`.
  return Boolean(keyId() && process.env.RAZORPAY_KEY_SECRET?.trim() && amountMinor());
}

/**
 * Creates an order, or hands back one already awaiting payment.
 *
 * The reuse matters for the same reason it does for subscriptions: two clicks
 * on a slow button, or a reopened page after a dismissed dialog, would
 * otherwise raise a second order — and Razorpay will happily collect on both.
 * An unpaid order is reopenable; only a paid one is finished.
 */
export async function startOrder(
  collegeId: string,
  actorEmail: string | null,
): Promise<OrderCheckout> {
  if (!ordersConfigured()) {
    throw Object.assign(
      new Error("Payments are not available on this server yet."),
      { status: 503 },
    );
  }

  const pending = (await Invoice.findOne({
    tenantId: collegeId,
    status: "DUE",
    providerOrderId: { $type: "string" },
  }).sort({ issuedAt: -1 })) as IInvoice | null;

  if (pending) {
    return { order: view(pending), keyId: keyId()!, testMode: isTestMode() };
  }

  const amount = amountMinor()!;
  // Razorpay caps `receipt` at 40 characters, and it has to be unique enough
  // that two orders raised in the same second do not share one.
  const receipt = `wx_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  const order = await createAtRazorpay({
    amountMinor: amount,
    currency: currency(),
    receipt,
    tenantId: collegeId,
  });

  const invoice = (await Invoice.create({
    tenantId: collegeId,
    number: receipt,
    description: "WebXite subscription",
    amountMinor: order.amount,
    currency: order.currency,
    status: "DUE",
    issuedAt: new Date(),
    providerOrderId: order.id,
  })) as IInvoice;

  await AuditLog.create({
    action: "ORDER_CREATED",
    tenantId: collegeId,
    details: { actor: actorEmail, orderId: order.id, amountMinor: order.amount },
  }).catch(() => null);

  return { order: view(invoice), keyId: keyId()!, testMode: isTestMode() };
}

/**
 * Verifies what Checkout handed the browser, and marks the invoice paid.
 *
 * Two checks, and both are needed. The signature proves the payload came from
 * Razorpay rather than a console; re-reading the order proves Razorpay actually
 * holds the money. A signature alone would accept a replay of an older,
 * genuine payload — and the browser is never the source of "paid".
 *
 * The invoice is found scoped to the caller's own tenant, so a payload lifted
 * from somebody else's checkout settles nothing.
 */
export async function verifyOrder(
  collegeId: string,
  input: unknown,
  actorEmail: string | null,
): Promise<OrderView> {
  const body = (input ?? {}) as Record<string, unknown>;

  const orderId = typeof body.razorpay_order_id === "string" ? body.razorpay_order_id.trim() : "";
  const paymentId =
    typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id.trim() : "";
  const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature.trim() : "";

  if (!orderId || !paymentId || !signature) {
    throw new BadRequest(
      "razorpay_order_id, razorpay_payment_id and razorpay_signature are all required.",
    );
  }

  const invoice = (await Invoice.findOne({
    tenantId: collegeId,
    providerOrderId: orderId,
  })) as IInvoice | null;

  if (!invoice) throw new NotFound("No such order for this account.");

  if (!orderPaymentSignatureValid({ orderId, paymentId, signature })) {
    await AuditLog.create({
      action: "ORDER_VERIFICATION_FAILED",
      tenantId: collegeId,
      details: { actor: actorEmail, orderId, reason: "signature mismatch" },
    }).catch(() => null);

    // Nothing is written to the invoice. A failed verification must leave no
    // trace of progress, or a retry loop slowly walks a record towards paid.
    throw new BadRequest("That payment could not be verified.");
  }

  /*
   * Razorpay's own copy. `amount_paid` is the only statement of what was
   * actually collected; the browser supplies identifiers and nothing else.
   */
  const remote = await fetchOrder(orderId).catch(() => null);
  if (remote && remote.status !== "paid") {
    throw new BadRequest("Razorpay has not confirmed this payment yet.");
  }

  // Idempotent: a second verification of an already-paid order is a re-click,
  // not an error, and re-stamping `paidAt` would move a date that already
  // happened.
  if (invoice.status !== "PAID") {
    invoice.status = "PAID";
    invoice.paidAt = new Date();
    invoice.providerPaymentId = paymentId;
    await invoice.save();

    await AuditLog.create({
      action: "ORDER_PAID",
      tenantId: collegeId,
      details: { actor: actorEmail, orderId, paymentId },
    }).catch(() => null);
  }

  return view(invoice);
}

/** The most recent one-time payment for this tenant, if any. */
export async function latestOrder(collegeId: string): Promise<OrderView | null> {
  const row = (await Invoice.findOne({
    tenantId: collegeId,
    providerOrderId: { $type: "string" },
  }).sort({ issuedAt: -1 })) as IInvoice | null;

  return row ? view(row) : null;
}

/** What the checkout screen needs before anybody clicks anything. */
export async function orderState(collegeId: string): Promise<{
  configured: boolean;
  testMode: boolean;
  amountMinor: number | null;
  currency: string;
  latest: OrderView | null;
}> {
  return {
    configured: ordersConfigured(),
    testMode: isTestMode(),
    amountMinor: amountMinor(),
    currency: currency(),
    latest: await latestOrder(collegeId),
  };
}

export const __testing = { amountMinor, currency };
