import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ENTITLED_STATUSES, OCCUPYING_STATUSES } from "@/models/billing.model";
import { __testing } from "@/subscription-service";

const { asStatus, at, maskVpa, totalCount } = __testing;

/**
 * The pure decisions in the subscription flow.
 *
 * Everything that touches Mongo or Razorpay is covered by the manual test
 * procedure in RAZORPAY.md, because a unit test of it would be a test of two
 * mocks agreeing with each other. What is worth pinning here are the rules that
 * decide *entitlement*, since every one of them is a way to accidentally give
 * away a paid product.
 */

describe("asStatus — an unknown state never grants access", () => {
  it("passes through every status Razorpay documents", () => {
    for (const status of [
      "created",
      "authenticated",
      "active",
      "pending",
      "halted",
      "cancelled",
      "completed",
      "expired",
    ]) {
      assert.equal(asStatus(status), status);
    }
  });

  it("is case- and whitespace-insensitive", () => {
    assert.equal(asStatus("  ACTIVE "), "active");
  });

  /**
   * The invariant. A status Razorpay adds later must not be written into a
   * document whose schema enum would reject it — that save would throw inside a
   * webhook handler and Razorpay would retry the delivery forever. Falling back
   * to `pending` keeps the row writable, and `pending` is deliberately not in
   * ENTITLED_STATUSES, so the unknown state grants nothing.
   */
  it("falls back to a status that is writable and not entitled", () => {
    for (const unknown of ["paused", "some_new_state", "", "active; DROP"]) {
      const mapped = asStatus(unknown);
      assert.equal(mapped, "pending");
      assert.equal(ENTITLED_STATUSES.includes(mapped), false);
    }
  });
});

describe("the two status sets", () => {
  /**
   * `created` is a subscription opened at Razorpay and not yet paid. It must
   * occupy the tenant's slot — otherwise a second click sells a second
   * subscription — while granting nothing.
   */
  it("lets an unpaid subscription block a duplicate without entitling anyone", () => {
    assert.equal(OCCUPYING_STATUSES.includes("created"), true);
    assert.equal(ENTITLED_STATUSES.includes("created"), false);
  });

  /**
   * `halted` and `pending` are live subscriptions whose last charge failed. The
   * fix is retrying the existing mandate, not selling a new one — but access is
   * not owed while the money has not arrived.
   */
  it("treats a failing subscription as occupied but not entitled", () => {
    for (const status of ["pending", "halted"] as const) {
      assert.equal(OCCUPYING_STATUSES.includes(status), true);
      assert.equal(ENTITLED_STATUSES.includes(status), false);
    }
  });

  it("frees the slot once a subscription has ended", () => {
    for (const status of ["cancelled", "completed", "expired"] as const) {
      assert.equal(OCCUPYING_STATUSES.includes(status), false);
      assert.equal(ENTITLED_STATUSES.includes(status), false);
    }
  });

  /** Everything entitled must also be occupying, or a paying tenant could buy twice. */
  it("keeps entitled a subset of occupying", () => {
    for (const status of ENTITLED_STATUSES) {
      assert.equal(OCCUPYING_STATUSES.includes(status), true);
    }
  });
});

describe("at — Razorpay sends seconds, Mongo stores dates", () => {
  it("converts epoch seconds to a Date", () => {
    assert.deepEqual(at(1_700_000_000), new Date(1_700_000_000_000));
  });

  /**
   * Razorpay omits these fields on a subscription that has not started, and
   * sends 0 rather than null in places. Both mean "not yet", and neither may
   * become 1 January 1970 in a renewal date shown to a customer.
   */
  it("reads absent, null and zero as no date", () => {
    assert.equal(at(undefined), null);
    assert.equal(at(null), null);
    assert.equal(at(0), null);
  });
});

describe("maskVpa — recognisable to its owner, not reusable by anybody else", () => {
  it("keeps the bank handle and masks the name", () => {
    assert.equal(maskVpa("kishore@okhdfcbank"), "k••••••@okhdfcbank");
  });

  it("masks a single-character name without producing a bare @", () => {
    assert.equal(maskVpa("k@okaxis"), "k•@okaxis");
  });

  /** Razorpay omits `vpa` for every method that is not UPI. */
  it("is null for absent or malformed handles", () => {
    for (const value of [null, undefined, "", "notaupi", "@nobank", "noname@"]) {
      assert.equal(maskVpa(value), null);
    }
  });
});

describe("totalCount", () => {
  const original = process.env.RAZORPAY_TOTAL_COUNT;
  afterEach(() => {
    if (original === undefined) delete process.env.RAZORPAY_TOTAL_COUNT;
    else process.env.RAZORPAY_TOTAL_COUNT = original;
  });

  it("defaults to a year of monthly cycles", () => {
    delete process.env.RAZORPAY_TOTAL_COUNT;
    assert.equal(totalCount(), 12);
  });

  it("takes a configured count", () => {
    process.env.RAZORPAY_TOTAL_COUNT = "36";
    assert.equal(totalCount(), 36);
  });

  /**
   * A bad value must not reach Razorpay: `total_count: 0` is rejected outright
   * and a negative or absurd one would either fail the call or commit a tenant
   * to a mandate nobody intended.
   */
  it("ignores junk, zero, negatives and absurd counts", () => {
    for (const junk of ["", "abc", "0", "-5", "1.5", "100000"]) {
      process.env.RAZORPAY_TOTAL_COUNT = junk;
      assert.equal(totalCount(), 12);
    }
  });
});
