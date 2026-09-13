import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { __testing } from "@/analytics-service";

const { normalizePath, deviceTypeOf, clampPercent, hashVisitor } = __testing;

/**
 * The pure decisions in telemetry ingestion.
 *
 * Two of these are privacy boundaries rather than correctness details, and they
 * are the reason this file exists: a path that keeps its query string, or a
 * visitor hash that is stable across days, turns an analytics table into a
 * record of who read what.
 */

describe("normalizePath — what is safe to store and group by", () => {
  /**
   * The one that matters. Query strings are where password-reset tokens, email
   * addresses and session ids live, and a path column is read back by a
   * dashboard and kept for ninety days.
   */
  it("drops the query string entirely", () => {
    assert.equal(normalizePath("/reset?token=abc123&email=a@b.com"), "/reset");
    assert.equal(normalizePath("/?utm_source=x"), "/");
  });

  it("drops the fragment", () => {
    assert.equal(normalizePath("/about#team"), "/about");
  });

  it("accepts a full URL and keeps only the path", () => {
    assert.equal(normalizePath("https://g7a.in/admissions?x=1"), "/admissions");
  });

  /** /about and /about/ are one page; two rows would split every report. */
  it("collapses a trailing slash, but not the root", () => {
    assert.equal(normalizePath("/about/"), "/about");
    assert.equal(normalizePath("/about///"), "/about");
    assert.equal(normalizePath("/"), "/");
  });

  it("falls back to the root for junk", () => {
    for (const junk of [null, undefined, "", 42, {}, "https://"]) {
      assert.equal(normalizePath(junk), "/");
    }
  });

  it("adds a leading slash to a bare path", () => {
    assert.equal(normalizePath("contact"), "/contact");
  });

  it("bounds the length", () => {
    assert.ok(normalizePath("/" + "a".repeat(2000)).length <= 512);
  });
});

describe("deviceTypeOf", () => {
  /**
   * Bots are classified so they can be dropped. Counting a crawler would make
   * every figure wrong in the same direction: a site with no visitors and an
   * attentive crawler reports steady traffic and a perfect scroll depth.
   */
  it("recognises crawlers", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1)",
      "Chrome-Lighthouse",
      "HeadlessChrome/120",
      "Pingdom.com_bot",
    ]) {
      assert.equal(deviceTypeOf(ua), "bot");
    }
  });

  it("separates mobile, tablet and desktop", () => {
    assert.equal(deviceTypeOf("iPhone; CPU iPhone OS 17_0 like Mac OS X"), "mobile");
    assert.equal(deviceTypeOf("Mozilla/5.0 (iPad; CPU OS 17_0)"), "tablet");
    assert.equal(deviceTypeOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "desktop");
  });

  it("reads an absent user agent as unknown, not as desktop", () => {
    assert.equal(deviceTypeOf(""), "unknown");
  });
});

describe("clampPercent — a client value is a claim, not a fact", () => {
  it("keeps a sane value", () => {
    assert.equal(clampPercent(47), 47);
    assert.equal(clampPercent("63"), 63);
  });

  /** The beacon is a POST anybody can craft. 10000% must not reach a chart. */
  it("clamps a real number that is out of range", () => {
    assert.equal(clampPercent(10_000), 100);
    assert.equal(clampPercent(-5), 0);
  });

  /**
   * Junk reads as 0, not as 100.
   *
   * Infinity is the interesting one: clamping it to 100 would be arithmetically
   * defensible and wrong in effect, because it credits a crafted beacon with
   * having read the whole page. Anything that is not a finite number is not a
   * measurement, and an unmeasured view sits at the bottom of the funnel.
   */
  it("treats anything that is not a finite number as unmeasured", () => {
    for (const junk of ["abc", null, undefined, {}, [], NaN, Infinity, -Infinity]) {
      assert.equal(clampPercent(junk), 0);
    }
  });

  it("rounds rather than truncating", () => {
    assert.equal(clampPercent(49.6), 50);
  });
});

describe("hashVisitor — an address is never stored", () => {
  const saved = { salt: process.env.ANALYTICS_SALT, session: process.env.SESSION_SECRET };

  beforeEach(() => {
    process.env.ANALYTICS_SALT = "test-salt-value";
    process.env.SESSION_SECRET = "test-session-secret-at-least-32-chars";
  });

  afterEach(() => {
    if (saved.salt === undefined) delete process.env.ANALYTICS_SALT;
    else process.env.ANALYTICS_SALT = saved.salt;
    if (saved.session === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = saved.session;
  });

  it("is stable for the same visitor within a day", () => {
    const a = hashVisitor("203.0.113.9", "Mozilla/5.0");
    const b = hashVisitor("203.0.113.9", "Mozilla/5.0");
    assert.equal(a, b);
  });

  it("differs between visitors", () => {
    assert.notEqual(
      hashVisitor("203.0.113.9", "Mozilla/5.0"),
      hashVisitor("203.0.113.10", "Mozilla/5.0"),
    );
  });

  /** The address must not be recoverable from what is stored. */
  it("does not contain the address", () => {
    const hash = hashVisitor("203.0.113.9", "Mozilla/5.0");
    assert.ok(!hash.includes("203"));
    assert.ok(/^[0-9a-f]{32}$/.test(hash));
  });

  /**
   * The salt is what makes the hash more than an obfuscated address. Without a
   * secret, a 32-bit space of IPv4 addresses is exhaustible in seconds.
   */
  it("changes entirely with the salt", () => {
    const before = hashVisitor("203.0.113.9", "Mozilla/5.0");
    process.env.ANALYTICS_SALT = "a-different-salt";
    assert.notEqual(hashVisitor("203.0.113.9", "Mozilla/5.0"), before);
  });
});
