import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Razorpay, over `fetch`, with no SDK.
 *
 * The `razorpay` npm package is a thin wrapper over four REST calls and an HMAC,
 * and this service already talks to Google's identity endpoints the same way —
 * `fetch` plus `jose` — so a second HTTP style for one provider would be the odd
 * one out. What the SDK would add is a dependency in the path of payments; what
 * it would save is about thirty lines. The verification below is the part that
 * has to be right, and it is `createHmac` either way.
 *
 * Nothing in this module decides what a subscription costs. The amount,
 * currency and interval live on a Plan created in the Razorpay Dashboard and
 * referenced by `RAZORPAY_PLAN_ID`. This platform does not hold a second
 * opinion about the price — that is how the number on the pricing page stops
 * matching the number on the card statement.
 */

const API = "https://api.razorpay.com/v1";

export class RazorpayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Razorpay's own error code, when it sent one. Never a secret. */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "RazorpayError";
  }
}

export function keyId(): string | null {
  return process.env.RAZORPAY_KEY_ID?.trim() || null;
}

function keySecret(): string | null {
  return process.env.RAZORPAY_KEY_SECRET?.trim() || null;
}

export function planId(): string | null {
  return process.env.RAZORPAY_PLAN_ID?.trim() || null;
}

function webhookSecret(): string | null {
  return process.env.RAZORPAY_WEBHOOK_SECRET?.trim() || null;
}

/**
 * Whether subscriptions can be sold at all.
 *
 * All three are required together: a key with no plan can create nothing, and a
 * plan with no key cannot be charged. A half-configured deployment reports
 * itself unconfigured rather than offering a button that fails at the last step.
 */
export function razorpayConfigured(): boolean {
  return Boolean(keyId() && keySecret() && planId());
}

/** Whether this deployment is pointed at Razorpay's test mode. */
export function isTestMode(): boolean {
  return (keyId() ?? "").startsWith("rzp_test_");
}

/** Whether webhook delivery is configured. Reported, never inferred from traffic. */
export function webhookConfigured(): boolean {
  return Boolean(webhookSecret());
}

function authHeader(): string {
  const id = keyId();
  const secret = keySecret();
  if (!id || !secret) {
    throw new RazorpayError("Razorpay is not configured on this server.", 503);
  }
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

/**
 * One call to Razorpay.
 *
 * Razorpay answers an error as `{ error: { code, description, ... } }`. The
 * description is written for a developer and is safe to pass on; the rest is
 * not necessarily, so only those two fields leave this function. The key secret
 * exists only inside `authHeader` and is never logged or returned.
 */
async function call<T>(
  path: string,
  init: { method: "GET" | "POST" | "PATCH" | "DELETE"; body?: unknown } = {
    method: "GET",
  },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: init.method,
      headers: {
        Authorization: authHeader(),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      /*
       * Razorpay sits in the path of a user watching a checkout dialog. A
       * gateway that has stopped answering has to fail rather than hold the
       * request open until the browser gives up on it.
       */
      signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    if (cause instanceof RazorpayError) throw cause;
    throw new RazorpayError("Could not reach Razorpay. Try again.", 502);
  }

  const payload = (await response.json().catch(() => null)) as
    | { error?: { code?: string; description?: string } }
    | null;

  if (!response.ok) {
    const description = payload?.error?.description;
    throw new RazorpayError(
      description || `Razorpay rejected the request (${response.status}).`,
      // A 4xx from Razorpay is our bug or the caller's, not an outage. 502 is
      // reported only when the gateway itself failed.
      response.status >= 500 ? 502 : response.status,
      payload?.error?.code ?? null,
    );
  }

  return payload as T;
}

export type RazorpayPlan = {
  id: string;
  period: string;
  interval: number;
  item: {
    name: string;
    amount: number;
    currency: string;
    description?: string | null;
  };
};

export type RazorpaySubscription = {
  id: string;
  plan_id: string;
  customer_id?: string | null;
  status: string;
  short_url?: string | null;
  current_start?: number | null;
  current_end?: number | null;
  ended_at?: number | null;
  charge_at?: number | null;
  paid_count?: number;
  total_count?: number;
  notes?: Record<string, string> | null;
};

/** The configured plan, as Razorpay holds it. This is where the price comes from. */
export function fetchPlan(id: string): Promise<RazorpayPlan> {
  return call<RazorpayPlan>(`/plans/${encodeURIComponent(id)}`);
}

/**
 * Creates a subscription against the configured plan.
 *
 * `total_count` is how many billing cycles Razorpay will attempt before the
 * subscription completes. The API requires it and offers no "forever" value, so
 * it is configurable rather than a guess at how long a customer stays.
 *
 * `notes` carries the tenant id back on every webhook, which is what lets an
 * event be attributed without trusting anything the browser said.
 */
export function createSubscription(input: {
  planId: string;
  totalCount: number;
  tenantId: string;
  notify: boolean;
}): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>("/subscriptions", {
    method: "POST",
    body: {
      plan_id: input.planId,
      total_count: input.totalCount,
      customer_notify: input.notify ? 1 : 0,
      notes: { tenantId: input.tenantId },
    },
  });
}

export type RazorpayPayment = {
  id: string;
  /** "card", "upi", "netbanking", "wallet", "emandate", … */
  method?: string | null;
  card?: {
    last4?: string | null;
    network?: string | null;
    type?: string | null;
    issuer?: string | null;
  } | null;
  /** UPI handle, when the mandate is a UPI one. */
  vpa?: string | null;
  bank?: string | null;
  wallet?: string | null;
};

/**
 * One payment, for the instrument behind it.
 *
 * This is the only way this platform learns what a tenant paid with, and it
 * learns it from Razorpay after the fact rather than by asking anybody to type
 * a card number here. What comes back is display metadata — a network name and
 * four digits — which is what a person needs to tell two of their own cards
 * apart and is not card data.
 */
export function fetchPayment(id: string): Promise<RazorpayPayment> {
  return call<RazorpayPayment>(`/payments/${encodeURIComponent(id)}`);
}

export function fetchSubscription(id: string): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>(`/subscriptions/${encodeURIComponent(id)}`);
}

/**
 * Cancels a subscription.
 *
 * `cancelAtCycleEnd` is the humane default: the tenant has paid for the current
 * period and keeps it. Cancelling immediately is available, but it is not what
 * a "cancel" button should do without saying so first.
 */
export function cancelSubscription(
  id: string,
  cancelAtCycleEnd: boolean,
): Promise<RazorpaySubscription> {
  return call<RazorpaySubscription>(
    `/subscriptions/${encodeURIComponent(id)}/cancel`,
    { method: "POST", body: { cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0 } },
  );
}

/** Constant-time compare of two hex digests, tolerant of a wrong-length input. */
function digestsMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself be a timing
  // signal — and a wrong length is simply a wrong signature.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Whether Checkout's handler payload really came from Razorpay.
 *
 * The signed string for a **subscription** is `payment_id|subscription_id` — the
 * opposite order to the one-time order flow, which signs `order_id|payment_id`.
 * Reversing the two produces a verifier that rejects every genuine payment, and
 * one tested only against its own output would look perfect while accepting
 * nothing real.
 *
 * Signed with the **key secret**, which is not the webhook secret.
 */
export function subscriptionPaymentSignatureValid(input: {
  paymentId: string;
  subscriptionId: string;
  signature: string;
}): boolean {
  const secret = keySecret();
  if (!secret) return false;

  const expected = createHmac("sha256", secret)
    .update(`${input.paymentId}|${input.subscriptionId}`)
    .digest("hex");

  return digestsMatch(expected, input.signature);
}

/**
 * Whether a webhook body really came from Razorpay.
 *
 * Signed over the **raw request bytes**, with the **webhook secret** — a
 * separate value from the key secret, set separately in the Dashboard. It has
 * to be the bytes as received: `JSON.stringify(req.body)` re-serialises, and any
 * difference in key order, unicode escaping or number formatting changes the
 * digest and rejects a genuine event.
 */
export function webhookSignatureValid(
  rawBody: Buffer,
  signature: string,
): boolean {
  const secret = webhookSecret();
  if (!secret) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return digestsMatch(expected, signature);
}

export const __testing = { digestsMatch };
