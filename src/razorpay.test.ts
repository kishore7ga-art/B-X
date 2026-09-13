import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  isTestMode,
  razorpayConfigured,
  subscriptionPaymentSignatureValid,
  webhookConfigured,
  webhookSignatureValid,
} from "@/razorpay";

/**
 * The signature checks, which are the whole security boundary.
 *
 * Everything else in the payment flow is bookkeeping. These two functions are
 * the only thing standing between a POST written by hand in a console and a
 * subscription marked active, so they are tested against digests computed the
 * way Razorpay computes them rather than the way the implementation does — a
 * test that calls the same helper the code calls proves only that the helper is
 * deterministic.
 */

const KEY_SECRET = "test_key_secret_not_a_real_one_000";
const WEBHOOK_SECRET = "test_webhook_secret_not_a_real_one";

const saved: Record<string, string | undefined> = {};
const KEYS = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_PLAN_ID",
  "RAZORPAY_WEBHOOK_SECRET",
];

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.RAZORPAY_KEY_ID = "rzp_test_abc123";
  process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
  process.env.RAZORPAY_PLAN_ID = "plan_abc123";
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("subscriptionPaymentSignatureValid", () => {
  const paymentId = "pay_LxRnT1example";
  const subscriptionId = "sub_LxRnT1example";

  /** Razorpay's own recipe, written out rather than borrowed from the module. */
  const sign = (message: string, secret = KEY_SECRET) =>
    createHmac("sha256", secret).update(message).digest("hex");

  it("accepts a signature Razorpay would have produced", () => {
    assert.equal(
      subscriptionPaymentSignatureValid({
        paymentId,
        subscriptionId,
        signature: sign(`${paymentId}|${subscriptionId}`),
      }),
      true,
    );
  });

  /**
   * The finding this test exists for. A subscription signs
   * `payment_id|subscription_id`; a one-time *order* signs
   * `order_id|payment_id`. Copying the order recipe into the subscription flow
   * produces a verifier that rejects every genuine payment — and one written
   * and tested against its own output would look perfect.
   */
  it("rejects the order flow's operand order", () => {
    assert.equal(
      subscriptionPaymentSignatureValid({
        paymentId,
        subscriptionId,
        signature: sign(`${subscriptionId}|${paymentId}`),
      }),
      false,
    );
  });

  it("rejects a signature made with a different secret", () => {
    assert.equal(
      subscriptionPaymentSignatureValid({
        paymentId,
        subscriptionId,
        signature: sign(`${paymentId}|${subscriptionId}`, "some-other-secret"),
      }),
      false,
    );
  });

  it("rejects a payload whose ids were swapped after signing", () => {
    const signature = sign(`${paymentId}|${subscriptionId}`);
    assert.equal(
      subscriptionPaymentSignatureValid({
        paymentId: "pay_somebodyElses",
        subscriptionId,
        signature,
      }),
      false,
    );
  });

  /**
   * `timingSafeEqual` throws on a length mismatch. Letting that propagate would
   * turn a malformed signature into a 500 and, worse, make "wrong length" and
   * "wrong value" distinguishable to a caller.
   */
  it("rejects a short, empty or overlong signature without throwing", () => {
    for (const signature of ["", "00", "f".repeat(1000)]) {
      assert.equal(
        subscriptionPaymentSignatureValid({ paymentId, subscriptionId, signature }),
        false,
      );
    }
  });

  it("refuses everything when no key secret is configured", () => {
    const signature = sign(`${paymentId}|${subscriptionId}`);
    delete process.env.RAZORPAY_KEY_SECRET;
    assert.equal(
      subscriptionPaymentSignatureValid({ paymentId, subscriptionId, signature }),
      false,
    );
  });
});

describe("webhookSignatureValid", () => {
  const rawBody = Buffer.from(
    JSON.stringify({ event: "subscription.activated", payload: {} }),
    "utf8",
  );

  const sign = (body: Buffer, secret = WEBHOOK_SECRET) =>
    createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a body signed with the webhook secret", () => {
    assert.equal(webhookSignatureValid(rawBody, sign(rawBody)), true);
  });

  /**
   * The webhook secret and the key secret are different values set in different
   * places in the Dashboard. Verifying a webhook with the key secret is a
   * plausible mistake that would reject every genuine event.
   */
  it("rejects a body signed with the key secret instead", () => {
    assert.equal(webhookSignatureValid(rawBody, sign(rawBody, KEY_SECRET)), false);
  });

  /**
   * Why the raw bytes are captured rather than re-serialised from `req.body`:
   * a round trip through JSON.parse/stringify is not byte-identical, and the
   * digest is over bytes.
   */
  it("rejects a re-serialised body, which is why raw bytes are kept", () => {
    const signature = sign(rawBody);
    const reserialised = Buffer.from(
      JSON.stringify(JSON.parse(rawBody.toString("utf8")), null, 2),
      "utf8",
    );
    assert.equal(webhookSignatureValid(reserialised, signature), false);
  });

  it("rejects a tampered body", () => {
    const signature = sign(rawBody);
    const tampered = Buffer.from(
      JSON.stringify({ event: "subscription.activated", payload: { evil: true } }),
      "utf8",
    );
    assert.equal(webhookSignatureValid(tampered, signature), false);
  });

  it("refuses everything when no webhook secret is configured", () => {
    const signature = sign(rawBody);
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    assert.equal(webhookSignatureValid(rawBody, signature), false);
  });
});

describe("configuration is reported, never assumed", () => {
  it("needs a key, a secret and a plan together", () => {
    assert.equal(razorpayConfigured(), true);

    // A key with no plan can create nothing; a plan with no key cannot be
    // charged. Either alone must read as unconfigured, or the UI offers a
    // button whose last step fails.
    delete process.env.RAZORPAY_PLAN_ID;
    assert.equal(razorpayConfigured(), false);

    process.env.RAZORPAY_PLAN_ID = "plan_abc123";
    delete process.env.RAZORPAY_KEY_SECRET;
    assert.equal(razorpayConfigured(), false);
  });

  it("recognises test mode from the key id prefix", () => {
    assert.equal(isTestMode(), true);
    process.env.RAZORPAY_KEY_ID = "rzp_live_abc123";
    assert.equal(isTestMode(), false);
  });

  it("reports webhook configuration separately from keys", () => {
    assert.equal(webhookConfigured(), true);
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    // Keys are still present — a deployment can sell without having wired
    // webhooks, and the billing screen says so rather than pretending.
    assert.equal(razorpayConfigured(), true);
    assert.equal(webhookConfigured(), false);
  });
});
