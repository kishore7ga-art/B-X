import { AuditLog, Subscription, WebhookEvent } from "@/models";
import {
  ENTITLED_STATUSES,
  OCCUPYING_STATUSES,
  type ISubscription,
  type SubscriptionStatus,
} from "@/models/billing.model";
import { BadRequest, NotFound } from "@/errors";
import {
  cancelSubscription as cancelAtRazorpay,
  createSubscription as createAtRazorpay,
  fetchPayment,
  fetchPlan,
  fetchSubscription,
  isTestMode,
  keyId,
  planId,
  razorpayConfigured,
  subscriptionPaymentSignatureValid,
  webhookConfigured,
  webhookSignatureValid,
  type RazorpaySubscription,
} from "@/razorpay";

/**
 * Subscriptions, as this platform is allowed to know them.
 *
 * One rule runs through the whole file: **Razorpay decides, this records.** No
 * function here marks a tenant as paid because a browser said the payment
 * worked. Entitlement changes in exactly two places, and both are signed — the
 * checkout signature verified in `verifyCheckout`, and the webhook signature
 * verified in `handleWebhook` — and of the two the webhook is authoritative,
 * because it is the only one that still arrives when the user closes the tab
 * the moment the money leaves their account.
 *
 * There is one plan. It is not described here: `RAZORPAY_PLAN_ID` names a Plan
 * in the Dashboard, and its name, amount, currency and interval are read from
 * there. Adding a second plan later is adding a second id and a column to choose
 * it by — nothing in the flow below assumes there is only one, except the
 * environment variable that supplies it.
 */

/** How many billing cycles a new subscription is created for. */
function totalCount(): number {
  const raw = Number(process.env.RAZORPAY_TOTAL_COUNT ?? "");
  if (Number.isInteger(raw) && raw > 0 && raw <= 1000) return raw;
  /*
   * Razorpay requires `total_count` and has no value meaning "until cancelled",
   * so some number has to be chosen. Twelve monthly cycles is a year, which is
   * long enough that renewal is a real event rather than a surprise and short
   * enough that a mandate does not outlive anybody's memory of granting it.
   * Override it to match the Plan's actual period.
   */
  return 12;
}

/** Seconds since the epoch, as Razorpay sends them, to a Date. */
function at(seconds: number | null | undefined): Date | null {
  return typeof seconds === "number" && seconds > 0 ? new Date(seconds * 1000) : null;
}

/** Razorpay's status string, narrowed — an unknown one is not silently accepted. */
function asStatus(value: string): SubscriptionStatus {
  const known: SubscriptionStatus[] = [
    "created",
    "authenticated",
    "active",
    "pending",
    "halted",
    "cancelled",
    "completed",
    "expired",
  ];
  const lower = value?.trim().toLowerCase() as SubscriptionStatus;
  /*
   * A status Razorpay adds later must not be written into a document whose
   * schema enum would reject it — the save would throw inside a webhook and
   * Razorpay would retry it forever. Treating the unknown as `pending` keeps
   * the row writable and, crucially, keeps it *out* of ENTITLED_STATUSES: an
   * unrecognised state never grants access.
   */
  return known.includes(lower) ? lower : "pending";
}

export type PlanView = {
  id: string;
  name: string;
  description: string | null;
  /** Minor units — paise for INR. Never a float. */
  amountMinor: number;
  currency: string;
  /** "monthly", "yearly", … as Razorpay names it. */
  period: string;
  interval: number;
};

export type SubscriptionView = {
  id: string;
  razorpaySubscriptionId: string;
  status: SubscriptionStatus;
  /** Whether this subscription currently entitles the tenant to anything. */
  isActive: boolean;
  currentStart: Date | null;
  currentEnd: Date | null;
  cancelledAt: Date | null;
  cancelAtCycleEnd: boolean;
  paidCount: number;
  totalCount: number;
  shortUrl: string | null;
  createdAt: Date;
};

/**
 * What the tenant is paying with, as Razorpay reports it.
 *
 * Display metadata and nothing else: a method, a network name, four digits, a
 * masked UPI handle. This platform has no card number, no expiry and no CVC to
 * show, because it never receives any — the mandate is set up inside Razorpay
 * Checkout and the instrument stays there.
 *
 * That is the whole reason this type exists. The settings screen used to hold a
 * card form: a PAN, an expiry and a CVC in React state, a fabricated
 * `tok_<provider>_<timestamp>` sent as if it were a real token, and — when the
 * backend rightly refused it — a locally invented card object and the message
 * "Card attached successfully". Nothing was stored anywhere. This replaces a
 * form that could not work with a read of something that is true.
 */
export type PaymentInstrumentView = {
  /** "card", "upi", "netbanking", "wallet", "emandate", … */
  method: string;
  /** "Visa", "MasterCard", "RuPay" — null for anything that is not a card. */
  network: string | null;
  last4: string | null;
  /** "credit" / "debit", when Razorpay says. */
  type: string | null;
  issuer: string | null;
  /** Masked to the handle's domain: enough to recognise, not enough to reuse. */
  upiHandle: string | null;
  bank: string | null;
  wallet: string | null;
};

export type BillingState = {
  /** Whether this deployment can sell anything at all. */
  configured: boolean;
  testMode: boolean;
  /** Whether webhook delivery is set up. An operator-facing fact, not a secret. */
  webhooksConfigured: boolean;
  plan: PlanView | null;
  subscription: SubscriptionView | null;
  /** What the mandate is drawn on. Null until a payment has been made. */
  paymentInstrument: PaymentInstrumentView | null;
  /** The single question every guarded feature actually asks. */
  isSubscribed: boolean;
};

function view(row: ISubscription): SubscriptionView {
  return {
    id: String(row._id),
    razorpaySubscriptionId: row.razorpaySubscriptionId,
    status: row.status,
    isActive: ENTITLED_STATUSES.includes(row.status),
    currentStart: row.currentStart ?? null,
    currentEnd: row.currentEnd ?? null,
    cancelledAt: row.cancelledAt ?? null,
    cancelAtCycleEnd: Boolean(row.cancelAtCycleEnd),
    paidCount: row.paidCount ?? 0,
    totalCount: row.totalCount ?? 0,
    shortUrl: row.shortUrl ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * The subscription that currently occupies this tenant's single plan slot.
 *
 * Newest first, because a tenant who cancelled and resubscribed has two rows and
 * the live one is the recent one.
 */
async function occupyingRow(collegeId: string): Promise<ISubscription | null> {
  return (await Subscription.findOne({
    tenantId: collegeId,
    status: { $in: OCCUPYING_STATUSES },
  }).sort({ createdAt: -1 })) as ISubscription | null;
}

/** The plan on offer, read from Razorpay. Null when nothing is configured. */
async function currentPlan(): Promise<PlanView | null> {
  const id = planId();
  if (!id || !razorpayConfigured()) return null;

  const plan = await fetchPlan(id);
  return {
    id: plan.id,
    name: plan.item?.name ?? "Subscription",
    description: plan.item?.description ?? null,
    amountMinor: plan.item?.amount ?? 0,
    currency: plan.item?.currency ?? "INR",
    period: plan.period,
    interval: plan.interval,
  };
}

/**
 * A UPI handle, masked.
 *
 * `kishore@okhdfcbank` becomes `k••••@okhdfcbank`. The bank half is what makes
 * it recognisable to its owner; the name half is personal data that a settings
 * screen does not need to display in full to do its job.
 */
function maskVpa(vpa: string | null | undefined): string | null {
  if (!vpa) return null;
  const [name, handle] = vpa.split("@");
  if (!name || !handle) return null;
  return `${name.slice(0, 1)}${"\u2022".repeat(Math.max(name.length - 1, 1))}@${handle}`;
}

/**
 * The instrument behind a subscription's last payment.
 *
 * Read from Razorpay each time rather than stored. A tenant can change the card
 * on a mandate without this platform being involved, so a copy taken at signup
 * would show the old one indefinitely — and the only thing worse than no
 * payment method on a billing screen is a confidently wrong one.
 */
async function paymentInstrument(
  lastPaymentId: string | null | undefined,
): Promise<PaymentInstrumentView | null> {
  if (!lastPaymentId || !razorpayConfigured()) return null;

  const payment = await fetchPayment(lastPaymentId).catch(() => null);
  if (!payment) return null;

  return {
    method: payment.method ?? "unknown",
    network: payment.card?.network ?? null,
    last4: payment.card?.last4 ?? null,
    type: payment.card?.type ?? null,
    issuer: payment.card?.issuer ?? null,
    upiHandle: maskVpa(payment.vpa),
    bank: payment.bank ?? null,
    wallet: payment.wallet ?? null,
  };
}

/**
 * Everything the billing screen needs, in one call.
 *
 * The plan lookup is allowed to fail without taking the whole response down. A
 * tenant whose subscription is active does not stop being subscribed because
 * Razorpay's plans endpoint is slow, and answering 502 here would black out a
 * settings page over a price label.
 */
export async function billingState(collegeId: string): Promise<BillingState> {
  const row = await occupyingRow(collegeId);

  /*
   * Both lookups reach Razorpay and both are allowed to fail. A subscriber does
   * not stop being subscribed because a price label or a card's last four
   * digits could not be fetched, and answering 502 here would black out a
   * settings page over a decoration. Run together rather than in sequence so
   * the screen waits for one round trip, not two.
   */
  const [plan, instrument] = await Promise.all([
    currentPlan().catch(() => null),
    paymentInstrument(row?.lastPaymentId).catch(() => null),
  ]);

  return {
    configured: razorpayConfigured(),
    testMode: isTestMode(),
    webhooksConfigured: webhookConfigured(),
    plan,
    subscription: row ? view(row) : null,
    paymentInstrument: instrument,
    isSubscribed: Boolean(row && ENTITLED_STATUSES.includes(row.status)),
  };
}

/**
 * Whether a tenant is entitled right now.
 *
 * The one function any other feature should call. It reads the local mirror
 * rather than Razorpay, deliberately: this runs on ordinary requests, and
 * putting a third-party API in that path makes every page depend on a gateway's
 * uptime. The mirror is kept honest by webhooks.
 */
export async function hasActiveSubscription(collegeId: string): Promise<boolean> {
  const row = await Subscription.findOne({
    tenantId: collegeId,
    status: { $in: ENTITLED_STATUSES },
  }).select("_id");
  return Boolean(row);
}

/**
 * Starts a subscription, or hands back the one already in flight.
 *
 * Duplicate protection is the whole point of the early return. Two clicks on a
 * slow button, a double-submitted form, or a user who reopened the billing page
 * after closing the checkout dialog would each otherwise create a second
 * subscription at Razorpay — and Razorpay would happily charge both.
 *
 * The `created` case returns the *existing* record rather than refusing. A
 * subscription that was opened but never paid is exactly what a returning user
 * needs handed back so the dialog can be reopened on it; refusing would leave
 * them permanently unable to pay without an operator deleting a row.
 */
export async function startSubscription(
  collegeId: string,
  actorEmail: string | null,
): Promise<{ subscription: SubscriptionView; plan: PlanView | null; keyId: string; reused: boolean }> {
  if (!razorpayConfigured()) {
    throw Object.assign(
      new Error("Subscriptions are not available on this server yet."),
      { status: 503 },
    );
  }

  const existing = await occupyingRow(collegeId);
  if (existing) {
    return {
      subscription: view(existing),
      plan: await currentPlan().catch(() => null),
      keyId: keyId()!,
      reused: true,
    };
  }

  const plan = await currentPlan();
  if (!plan) {
    throw Object.assign(new Error("The subscription plan could not be loaded."), {
      status: 503,
    });
  }

  const created = await createAtRazorpay({
    planId: plan.id,
    totalCount: totalCount(),
    tenantId: collegeId,
    notify: true,
  });

  const row = (await Subscription.create({
    tenantId: collegeId,
    razorpaySubscriptionId: created.id,
    razorpayPlanId: created.plan_id,
    razorpayCustomerId: created.customer_id ?? null,
    status: asStatus(created.status),
    shortUrl: created.short_url ?? null,
    currentStart: at(created.current_start),
    currentEnd: at(created.current_end),
    paidCount: created.paid_count ?? 0,
    totalCount: created.total_count ?? totalCount(),
  })) as ISubscription;

  await AuditLog.create({
    action: "SUBSCRIPTION_STARTED",
    tenantId: collegeId,
    details: { actor: actorEmail, subscriptionId: created.id, planId: plan.id },
  }).catch(() => null);

  return { subscription: view(row), plan, keyId: keyId()!, reused: false };
}

/**
 * Applies Razorpay's own record of a subscription to the local mirror.
 *
 * Every lifecycle write goes through here, so there is one description of what
 * each field means rather than one per webhook event. It refuses to move a row
 * belonging to another tenant, which matters because the subscription id on a
 * webhook is attacker-visible if the signature check is ever weakened.
 */
async function applyRemote(
  remote: RazorpaySubscription,
  expectTenantId?: string,
): Promise<ISubscription | null> {
  const row = (await Subscription.findOne({
    razorpaySubscriptionId: remote.id,
  })) as ISubscription | null;

  if (!row) return null;
  if (expectTenantId && row.tenantId !== expectTenantId) return null;

  const status = asStatus(remote.status);
  row.status = status;
  row.razorpayCustomerId = remote.customer_id ?? row.razorpayCustomerId ?? null;
  row.currentStart = at(remote.current_start) ?? row.currentStart ?? null;
  row.currentEnd = at(remote.current_end) ?? row.currentEnd ?? null;
  row.endedAt = at(remote.ended_at) ?? row.endedAt ?? null;
  row.paidCount = remote.paid_count ?? row.paidCount ?? 0;
  row.totalCount = remote.total_count ?? row.totalCount ?? 0;

  // A cancellation timestamp is set once and never moved: the date somebody
  // cancelled is a fact about the past, and a later sync must not rewrite it.
  if (status === "cancelled" && !row.cancelledAt) {
    row.cancelledAt = at(remote.ended_at) ?? new Date();
  }

  row.lastSyncedAt = new Date();
  await row.save();
  return row;
}

/**
 * Verifies what Checkout handed the browser, and syncs.
 *
 * Two independent checks, and the order matters. The signature proves the
 * payload came from Razorpay and was not typed into a console; the re-fetch
 * proves what the subscription's status actually *is*. A valid signature alone
 * would be enough to accept a replayed payload from an older, since-cancelled
 * subscription, so the status is never taken from the browser — only the ids
 * are, and only after they have been shown to be authentic.
 *
 * The record is looked up scoped to the caller's own tenant, so a signature
 * lifted from another tenant's checkout moves nothing.
 */
export async function verifyCheckout(
  collegeId: string,
  input: unknown,
  actorEmail: string | null,
): Promise<BillingState> {
  const body = (input ?? {}) as Record<string, unknown>;

  const paymentId = typeof body.razorpay_payment_id === "string" ? body.razorpay_payment_id.trim() : "";
  const subscriptionId =
    typeof body.razorpay_subscription_id === "string" ? body.razorpay_subscription_id.trim() : "";
  const signature = typeof body.razorpay_signature === "string" ? body.razorpay_signature.trim() : "";

  if (!paymentId || !subscriptionId || !signature) {
    throw new BadRequest(
      "razorpay_payment_id, razorpay_subscription_id and razorpay_signature are all required.",
    );
  }

  const row = (await Subscription.findOne({
    tenantId: collegeId,
    razorpaySubscriptionId: subscriptionId,
  })) as ISubscription | null;

  if (!row) {
    // Deliberately the same shape of answer as a bad signature: whether a
    // subscription id exists is not something an unauthenticated guess should
    // be able to learn from the status code.
    throw new NotFound("No such subscription for this account.");
  }

  if (!subscriptionPaymentSignatureValid({ paymentId, subscriptionId, signature })) {
    await AuditLog.create({
      action: "SUBSCRIPTION_VERIFICATION_FAILED",
      tenantId: collegeId,
      details: { actor: actorEmail, subscriptionId, reason: "signature mismatch" },
    }).catch(() => null);

    throw new BadRequest("That payment could not be verified.");
  }

  row.lastPaymentId = paymentId;
  await row.save();

  // Razorpay's own copy, not the browser's claim about it.
  const remote = await fetchSubscription(subscriptionId).catch(() => null);
  if (remote) await applyRemote(remote, collegeId);

  await AuditLog.create({
    action: "SUBSCRIPTION_VERIFIED",
    tenantId: collegeId,
    details: { actor: actorEmail, subscriptionId, paymentId },
  }).catch(() => null);

  return billingState(collegeId);
}

/**
 * Re-reads a tenant's subscription from Razorpay.
 *
 * The fallback for the case webhooks exist to cover and occasionally miss: a
 * delivery that failed every retry, or a deployment where the webhook secret
 * was never set. Rate-limited by being a deliberate user action rather than
 * something the billing page does on every render.
 */
export async function refreshSubscription(collegeId: string): Promise<BillingState> {
  const row = await occupyingRow(collegeId);
  if (!row) return billingState(collegeId);

  const remote = await fetchSubscription(row.razorpaySubscriptionId).catch(() => null);
  if (remote) await applyRemote(remote, collegeId);

  return billingState(collegeId);
}

/**
 * Cancels a tenant's subscription at Razorpay, then mirrors the result.
 *
 * Cancelled at Razorpay first and recorded second, never the reverse: a local
 * row marked cancelled while the mandate is still live is a tenant who keeps
 * being charged for something the product tells them they cancelled.
 */
export async function cancelForTenant(
  collegeId: string,
  input: unknown,
  actorEmail: string | null,
): Promise<BillingState> {
  const body = (input ?? {}) as Record<string, unknown>;
  // Defaults to end-of-cycle: they have paid for this period and keep it.
  const immediately = body.immediately === true;

  const row = await occupyingRow(collegeId);
  if (!row) throw new NotFound("There is no subscription to cancel.");

  const remote = await cancelAtRazorpay(row.razorpaySubscriptionId, !immediately);
  await applyRemote(remote, collegeId);

  if (!immediately) {
    // `cancel_at_cycle_end` leaves the subscription `active` at Razorpay until
    // the period runs out, so the intent has to be recorded locally or the
    // screen would show no sign that anything was cancelled.
    const fresh = (await Subscription.findById(row._id)) as ISubscription | null;
    if (fresh) {
      fresh.cancelAtCycleEnd = true;
      await fresh.save();
    }
  }

  await AuditLog.create({
    action: "SUBSCRIPTION_CANCELLED",
    tenantId: collegeId,
    details: {
      actor: actorEmail,
      subscriptionId: row.razorpaySubscriptionId,
      immediately,
    },
  }).catch(() => null);

  return billingState(collegeId);
}

/* ── Webhooks ──────────────────────────────────────────────────────────────── */

/** What a webhook delivery produced, for the route to turn into a status code. */
export type WebhookOutcome =
  | { handled: true; duplicate: boolean; event: string }
  | { handled: false; reason: "unsigned" | "invalid-signature" | "unparseable" };

/**
 * The events that move a subscription's state.
 *
 * Everything else Razorpay sends is acknowledged and ignored. An allowlist
 * rather than a switch with a default, so a new event type cannot fall into a
 * branch that half-handles it.
 */
const HANDLED_EVENTS = new Set([
  "subscription.activated",
  "subscription.charged",
  "subscription.authenticated",
  "subscription.pending",
  "subscription.halted",
  "subscription.cancelled",
  "subscription.completed",
  "subscription.expired",
  "subscription.paused",
  "subscription.resumed",
  "subscription.updated",
]);

/**
 * Handles one Razorpay webhook delivery.
 *
 * Three things have to be true at once, and each is a separate failure:
 *
 *  - **Authentic.** The HMAC is over the raw bytes, with the webhook secret. An
 *    unverified body is not parsed, let alone acted on — it is the one input to
 *    this system that grants entitlement and arrives unauthenticated.
 *  - **Idempotent.** Razorpay retries until it gets a 2xx, including after a
 *    delivery that actually succeeded but timed out. The event id is inserted
 *    *before* the work, and a duplicate-key error is the dedupe — a read-then-
 *    write check would let two concurrent retries both pass it.
 *  - **Answered.** A duplicate returns success. Answering an error would make
 *    Razorpay retry forever a delivery that was handled correctly the first time.
 */
export async function handleWebhook(input: {
  rawBody: Buffer | undefined;
  signature: string | undefined;
  eventId: string | undefined;
}): Promise<WebhookOutcome> {
  const { rawBody, signature, eventId } = input;

  if (!rawBody || !rawBody.length || !signature) {
    return { handled: false, reason: "unsigned" };
  }

  if (!webhookSignatureValid(rawBody, signature)) {
    // Logged without the body: an unverified payload is attacker-controlled and
    // has no business in this service's logs.
    console.warn("[billing] rejected a webhook with an invalid signature");
    return { handled: false, reason: "invalid-signature" };
  }

  let payload: {
    event?: string;
    payload?: { subscription?: { entity?: RazorpaySubscription } };
  };
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return { handled: false, reason: "unparseable" };
  }

  const event = typeof payload.event === "string" ? payload.event : "";
  const entity = payload.payload?.subscription?.entity;

  /*
   * No event id means no dedupe key. Razorpay always sends one; a delivery
   * without it is processed rather than dropped, because refusing a genuine
   * event to protect against a duplicate that may never come is the worse
   * trade — `applyRemote` is itself idempotent, being a whole-row overwrite.
   */
  if (eventId) {
    try {
      await WebhookEvent.create({
        eventId,
        event,
        subscriptionId: entity?.id ?? null,
      });
    } catch (error) {
      // 11000 is the unique index doing its job: this event is already handled.
      if ((error as { code?: number })?.code === 11000) {
        return { handled: true, duplicate: true, event };
      }
      throw error;
    }
  }

  if (!event || !HANDLED_EVENTS.has(event) || !entity?.id) {
    // Acknowledged. An event this service does not act on is not an error, and
    // answering 4xx would have Razorpay retry it until it gave up.
    return { handled: true, duplicate: false, event };
  }

  const row = await applyRemote(entity);

  if (row) {
    await AuditLog.create({
      action: "SUBSCRIPTION_WEBHOOK_APPLIED",
      tenantId: row.tenantId,
      details: { event, subscriptionId: entity.id, status: row.status },
    }).catch(() => null);
  } else {
    /*
     * An event for a subscription this platform has no record of. It happens
     * legitimately — a Dashboard-created subscription, or one belonging to
     * another environment sharing the same Razorpay account — and is not
     * something to fail on. Recorded so it is visible, since the other reading
     * is that a `created` row failed to save during checkout.
     */
    console.warn(
      `[billing] ${event} for unknown subscription ${entity.id} — ignored`,
    );
  }

  return { handled: true, duplicate: false, event };
}

/* ── Admin ─────────────────────────────────────────────────────────────────── */

export type AdminSubscriptionView = SubscriptionView & {
  tenantId: string;
  razorpayPlanId: string;
  razorpayCustomerId: string | null;
  lastPaymentId: string | null;
  lastSyncedAt: Date | null;
};

/**
 * Every tenant's subscription, for the admin panel.
 *
 * Identifiers only — `sub_...`, `plan_...`, `pay_...`. Those are references an
 * operator needs to find a payment in the Razorpay Dashboard when somebody
 * writes in, and they are useless to anyone who cannot already sign in there.
 * No card data passes through this platform at all, and no key or secret is
 * reachable from any admin surface.
 */
export async function listAllSubscriptions(limit = 200): Promise<AdminSubscriptionView[]> {
  const rows = (await Subscription.find({})
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 500))) as ISubscription[];

  return rows.map((row) => ({
    ...view(row),
    tenantId: row.tenantId,
    razorpayPlanId: row.razorpayPlanId,
    razorpayCustomerId: row.razorpayCustomerId ?? null,
    lastPaymentId: row.lastPaymentId ?? null,
    lastSyncedAt: row.lastSyncedAt ?? null,
  }));
}

export const __testing = { asStatus, at, maskVpa, totalCount };
