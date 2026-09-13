# Razorpay subscriptions

## What this is

One recurring subscription, sold through Razorpay's Subscriptions API and
Standard Web Checkout. Razorpay owns the lifecycle; this platform keeps a mirror
of it and never decides for itself that somebody has paid.

```
app.webxite.org  ─ Settings → Subscription
        │  POST /api/v1/billing/subscription      create (or reuse) at Razorpay
        ▼
Razorpay Checkout  ─ user pays
        │  handler(payment_id, subscription_id, signature)
        ▼
        │  POST /api/v1/billing/subscription/verify
        │      1. HMAC check against the key secret
        │      2. re-read the subscription from Razorpay
        ▼
api.webxite.org  ─ subscription row updated
        ▲
        │  POST /api/v1/billing/razorpay/webhook   ← the authoritative path
Razorpay ─ subscription.activated / charged / halted / cancelled / expired
```

The browser is not trusted at any point. It supplies identifiers; status always
comes from Razorpay, either on the re-read or on a webhook.

## Where the price lives

**In the Razorpay Dashboard, on the Plan.** Not in this repository.

Before this, two screens each carried their own invented prices — the landing
page had Starter/Pro/Enterprise at \$19/\$49/custom, the editor's settings modal
had Campus Starter/two more at \$49/\$149 with a monthly-yearly toggle that
recomputed them in React — while the backend formatted currency as INR. None of
it was connected to anything. There was no plan record, no provider configured
and no button that could take money.

So the plan's name, amount, currency and interval are read from
`GET /v1/plans/{RAZORPAY_PLAN_ID}` and rendered as given. Nothing in this
codebase computes a price, which is the only arrangement where the number on the
pricing card and the number on the card statement cannot drift apart.

**Adding a second plan later** is adding a second id and something to choose it
by. Nothing in the flow assumes there is one plan except the environment
variable that supplies it — `startSubscription` takes the plan as an argument,
and the subscription row stores which plan it was bought against.

## Environment variables

On **XITE-B only**. None of these belong on any frontend.

```
RAZORPAY_KEY_ID=rzp_test_...          # publishable; reaches the browser via the API
RAZORPAY_KEY_SECRET=...               # server-only, signs and verifies
RAZORPAY_PLAN_ID=plan_...             # the single plan, created in the Dashboard
RAZORPAY_WEBHOOK_SECRET=...           # server-only, a DIFFERENT value from the key secret
RAZORPAY_TOTAL_COUNT=12               # optional; billing cycles per subscription
```

`RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are two different values set
in two different places in the Dashboard. Verifying a webhook with the key
secret is a plausible mistake that rejects every genuine event; there is a test
for exactly that.

### There is deliberately no `NEXT_PUBLIC_RAZORPAY_KEY_ID`

Razorpay's key id is publishable and would be safe in a bundle. It is not set
that way because it would be a second copy of a value the backend already holds,
set in a different dashboard, inlined at a different time. When the two drift,
Checkout opens against one account and verification runs against another, and
the only symptom is a signature that never matches. `POST /api/v1/billing/subscription`
returns `keyId` alongside the subscription, so there is one source.

## Endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/api/v1/billing/subscription` | tenant session |
| POST | `/api/v1/billing/subscription` | tenant session |
| POST | `/api/v1/billing/subscription/verify` | tenant session |
| POST | `/api/v1/billing/subscription/refresh` | tenant session |
| POST | `/api/v1/billing/subscription/cancel` | tenant session |
| POST | `/api/v1/billing/razorpay/webhook` | **signature only** |
| GET | `/api/v1/admin/subscriptions` | admin session |

All are in `src/openapi.ts` and in the prebuild coverage gate, so one cannot be
renamed without the build saying so.

## The three things that are easy to get wrong

**1. The signature operand order.** A subscription signs
`payment_id|subscription_id`. A one-time *order* signs `order_id|payment_id`.
They are the reverse of each other. Copying the order recipe into the
subscription flow yields a verifier that rejects every genuine payment — and one
written and tested against its own output looks perfect. `razorpay.test.ts` pins
both directions.

**2. The webhook needs the raw bytes.** The HMAC is over the body exactly as
sent. `JSON.stringify(req.body)` re-serialises, and any difference in key order,
unicode escaping or number formatting changes the digest. `server.ts` captures
`rawBody` in the JSON parser's `verify` hook, scoped to the webhook path.
`test-subscription-e2e.mjs` proves a correctly signed body still verifies *after*
passing through Express's parser, which is the case no unit test can reach.

**3. Idempotency must be a unique index, not a check.** Razorpay retries until it
gets a 2xx, including after a delivery that succeeded but timed out. A
`findOne`-then-insert lets two concurrent retries both through. The event id is
inserted first and the duplicate-key error *is* the dedupe.

## Duplicate protection

`startSubscription` returns the existing subscription instead of creating a
second one whenever the tenant has one in `created`, `authenticated`, `active`,
`pending` or `halted`.

`created` is in that list on purpose — it is a subscription opened at Razorpay
and not yet paid, so a double-clicked button would otherwise sell two. It is
*not* in `ENTITLED_STATUSES`, so it blocks a duplicate without granting access.
Same for `pending` and `halted`: those are live mandates whose last charge
failed, and the fix is retrying them, not selling a new one.

## Automated verification

```
npm run test:unit            # 330 tests, incl. 26 for signatures and status rules
npm run test:subscription    # 18 tests against a booted server + in-memory Mongo
```

`test:subscription` needs no Razorpay credentials and makes no outbound call:
every case is either a rejection (which happens before any outbound request) or
a webhook (which Razorpay initiates). It covers 401s on all five tenant routes
and the admin route, five webhook rejection paths, the signed-and-accepted path,
redelivery dedupe, unhandled-event acknowledgement, and that neither secret
appears in `/health` or `/openapi.json`.

## Manual verification — needs your test credentials

Nothing below can be run from this repository. Each needs a real Razorpay test
account.

**Dashboard setup, once:**

1. Razorpay Dashboard → **Test Mode**.
2. Settings → API Keys → generate. Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
3. Subscriptions → Plans → **Create Plan**. Pick the name, amount, currency and
   billing frequency — this is where the price is decided. Set `RAZORPAY_PLAN_ID`.
4. Settings → Webhooks → **Add New Webhook**.
   - URL: `https://api.webxite.org/api/v1/billing/razorpay/webhook`
   - Secret: generate one; set it as `RAZORPAY_WEBHOOK_SECRET`.
   - Events: `subscription.activated`, `subscription.charged`,
     `subscription.authenticated`, `subscription.pending`, `subscription.halted`,
     `subscription.cancelled`, `subscription.completed`, `subscription.expired`.

**Then, in the app:**

| # | Step | Expected |
|---|---|---|
| 1 | Settings → Subscription | Plan name and price from your Dashboard; "Test mode" banner |
| 2 | Subscribe | Razorpay Checkout opens |
| 3 | Pay with a Razorpay test card | Returns to the app, "Payment confirmed" |
| 4 | Reload | Still "Active" — it came from the server, not component state |
| 5 | Dashboard → Subscriptions | One subscription, not two |
| 6 | Click Subscribe twice quickly, before paying | Still one subscription at Razorpay |
| 7 | Close Checkout without paying | "Checkout closed. Nothing was charged." |
| 8 | Use a test card that fails | "The payment did not go through." Not activated |
| 9 | Dashboard → Webhooks → recent deliveries | 200, and a second manual redelivery also 200 |
| 10 | Cancel | "Ends on …" and it does not renew |
| 11 | admin.webxite.org → Users | Status, renewal date and `sub_…` on the tenant's card |
| 12 | Editor: create, edit, save, preview, publish | All unchanged |

**Test 8 matters most.** A failed payment that still activates a subscription is
the bug this whole architecture exists to prevent.

## What cannot be verified from here

- Any path that calls Razorpay: creating a subscription, fetching the plan,
  verifying a real payment signature, cancelling. All need live test credentials.
- Whether Razorpay can reach the webhook URL — that needs `api.webxite.org`
  publicly resolvable, which it is, and the webhook registered, which is manual.
- Renewal and expiry, which happen on Razorpay's clock over days or months.
