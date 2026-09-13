import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { MIN_PASSWORD_LENGTH, paymentProvider, __testing } from "@/account-service";

const { formatAmount } = __testing;

describe("paymentProvider — nothing is claimed that is not integrated", () => {
  const KEYS = [
    "PAYMENT_PROVIDER",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_PLAN_ID",
  ];
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      original[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("is null when nothing is configured", () => {
    assert.equal(paymentProvider(), null);
  });

  /**
   * A provider named in the environment but not implemented here would let the
   * settings screen open a flow this service cannot finish. Unknown names
   * therefore read as "none" rather than as themselves.
   */
  it("is null for a provider this service cannot actually talk to", () => {
    process.env.PAYMENT_PROVIDER = "some-gateway";
    assert.equal(paymentProvider(), null);
  });

  it("reports razorpay once its keys and plan are set", () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_abc";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    process.env.RAZORPAY_PLAN_ID = "plan_abc";
    assert.equal(paymentProvider(), "razorpay");
  });

  /**
   * The reason this is derived from Razorpay's own configuration rather than
   * from PAYMENT_PROVIDER. Naming a gateway is not wiring one up, and a screen
   * that believes the name would offer a purchase that cannot complete.
   */
  it("does not believe PAYMENT_PROVIDER=razorpay without the keys", () => {
    process.env.PAYMENT_PROVIDER = "razorpay";
    assert.equal(paymentProvider(), null);

    // Two of the three is still not a working gateway.
    process.env.RAZORPAY_KEY_ID = "rzp_test_abc";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    assert.equal(paymentProvider(), null);
  });

  it("still reports stripe from PAYMENT_PROVIDER", () => {
    process.env.PAYMENT_PROVIDER = "stripe";
    assert.equal(paymentProvider(), "stripe");
  });
});

describe("formatAmount — money is minor units, never a float", () => {
  it("renders rupees from paise", () => {
    // 4,999.00 — the separators are locale output, so only the digits and the
    // decimal placement are asserted.
    const formatted = formatAmount(499900, "INR");
    assert.match(formatted, /4[,.]?999\.00/);
  });

  it("does not lose precision on values a float would round", () => {
    assert.match(formatAmount(1010, "INR"), /10\.10/);
    assert.match(formatAmount(1, "INR"), /0\.01/);
    assert.match(formatAmount(0, "INR"), /0\.00/);
  });

  // An invoice in a currency Intl does not know must not take the billing page
  // down with it.
  it("falls back rather than throwing on an unknown currency", () => {
    const formatted = formatAmount(12345, "XXZ");
    assert.match(formatted, /123\.45/);
  });
});

describe("password policy", () => {
  it("requires a length a dictionary attack will not walk through", () => {
    assert.ok(MIN_PASSWORD_LENGTH >= 10, "minimum should be at least 10");
  });
});
