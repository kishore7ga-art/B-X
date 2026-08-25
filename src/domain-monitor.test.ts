import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isDue, nextCheckDelayMs } from "@/domain-monitor";

/**
 * The schedule, on its own.
 *
 * Pure arithmetic over a status and two timestamps, so it is testable without a
 * database, a DNS server or a timer — which matters, because the failure this
 * guards against is a background job that either never fires or never stops.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const now = Date.UTC(2026, 7, 25, 12, 0, 0);
const ago = (ms: number) => new Date(now - ms);

describe("nextCheckDelayMs — how often a domain is looked at", () => {
  it("re-reads a working domain every six hours", () => {
    // Not never. A domain that reached ACTIVE and then broke — a zone edited
    // months later, a certificate that failed to renew — used to keep its green
    // tick indefinitely, and the first report came from a customer.
    assert.equal(
      nextCheckDelayMs({ status: "ACTIVE", createdAt: ago(30 * DAY) }, now),
      6 * HOUR,
    );
  });

  it("backs off as a waiting domain keeps failing", () => {
    const delays = [1, 5, 30, 120, 600].map((minutes) =>
      nextCheckDelayMs({ status: "PENDING_VERIFICATION", createdAt: ago(minutes * MINUTE) }, now),
    );

    // Monotonic, so a domain nobody is fixing is asked about less and less.
    for (let i = 1; i < delays.length; i++) {
      assert.ok(delays[i]! >= delays[i - 1]!, `delay went down at step ${i}: ${delays.join(", ")}`);
    }
  });

  it("starts at a minute, so a tenant who just fixed DNS is not left waiting", () => {
    assert.equal(
      nextCheckDelayMs({ status: "PENDING_VERIFICATION", createdAt: ago(0) }, now),
      MINUTE,
    );
  });

  it("never spreads further apart than an hour", () => {
    const delay = nextCheckDelayMs(
      { status: "PENDING_VERIFICATION", createdAt: ago(40 * HOUR) },
      now,
    );
    assert.equal(delay, HOUR);
  });

  it("gives up after two days rather than resolving a dead name forever", () => {
    assert.equal(
      nextCheckDelayMs({ status: "PENDING_VERIFICATION", createdAt: ago(3 * DAY) }, now),
      null,
    );
  });

  it("never chases a disconnected domain", () => {
    // The row is kept for the audit trail. It is not a thing to re-check.
    assert.equal(nextCheckDelayMs({ status: "DISCONNECTED", createdAt: ago(MINUTE) }, now), null);
  });

  it("treats a missing createdAt as brand new rather than as ancient", () => {
    // A row written before this field existed must not be given up on
    // immediately because `undefined` read as epoch zero.
    assert.equal(nextCheckDelayMs({ status: "PENDING_VERIFICATION" }, now), MINUTE);
  });
});

describe("isDue — whether this one is ready now", () => {
  const domain = (over: Record<string, unknown> = {}) =>
    ({
      id: "d1",
      hostname: "college.test",
      status: "PENDING_VERIFICATION",
      createdAt: ago(10 * MINUTE),
      verificationCheckedAt: ago(10 * MINUTE),
      ...over,
    }) as never;

  it("is due once the backoff has elapsed", () => {
    assert.equal(isDue(domain({ verificationCheckedAt: ago(HOUR) }), now), true);
  });

  it("is not due a second after the last check", () => {
    assert.equal(isDue(domain({ verificationCheckedAt: ago(1000) }), now), false);
  });

  it("is due when it has never been checked", () => {
    assert.equal(isDue(domain({ verificationCheckedAt: null }), now), true);
  });

  it("is never due once disconnected", () => {
    assert.equal(
      isDue(domain({ status: "DISCONNECTED", verificationCheckedAt: ago(10 * DAY) }), now),
      false,
    );
  });

  it("is due for a working domain only after six hours", () => {
    const active = { status: "ACTIVE", createdAt: ago(30 * DAY) };
    assert.equal(isDue(domain({ ...active, verificationCheckedAt: ago(5 * HOUR) }), now), false);
    assert.equal(isDue(domain({ ...active, verificationCheckedAt: ago(7 * HOUR) }), now), true);
  });

  it("is never due once given up on, however long ago it was checked", () => {
    assert.equal(
      isDue(
        domain({ createdAt: ago(5 * DAY), verificationCheckedAt: ago(4 * DAY) }),
        now,
      ),
      false,
    );
  });
});
