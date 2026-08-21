import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { MIN_PASSWORD_LENGTH, paymentProvider, __testing } from "@/account-service";

const { formatAmount } = __testing;

describe("paymentProvider — nothing is claimed that is not integrated", () => {
  const original = process.env.PAYMENT_PROVIDER;
  afterEach(() => {
    if (original === undefined) delete process.env.PAYMENT_PROVIDER;
    else process.env.PAYMENT_PROVIDER = original;
  });

  it("is null when nothing is configured, which is the current state", () => {
    delete process.env.PAYMENT_PROVIDER;
    assert.equal(paymentProvider(), null);
  });

  /**
   * A provider named in the environment but not implemented here would let the
   * settings screen open a card flow this service cannot finish. Unknown names
   * therefore read as "none" rather than as themselves.
   */
  it("is null for a provider this service cannot actually talk to", () => {
    process.env.PAYMENT_PROVIDER = "some-gateway";
    assert.equal(paymentProvider(), null);
  });

  it("reports a known provider once one is configured", () => {
    process.env.PAYMENT_PROVIDER = "stripe";
    assert.equal(paymentProvider(), "stripe");
    process.env.PAYMENT_PROVIDER = "RAZORPAY";
    assert.equal(paymentProvider(), "razorpay");
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
