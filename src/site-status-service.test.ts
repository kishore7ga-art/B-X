import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { liveUrlFor, __testing } from "@/site-status-service";

const { statusFrom, preconditionsFor } = __testing;

/**
 * The status rules, which exist to make one specific lie impossible: a screen
 * saying LIVE for a site nobody can reach.
 *
 * All of these are pure. The status is derived on every read precisely so that
 * it can be tested this way — a stored column would need a database and a
 * migration to test, and would still be able to drift between them.
 */

const college = (over: Record<string, unknown> = {}) =>
  ({
    subdomain: "greenfield",
    users: [{ id: "u1" }],
    domains: [],
    publishedVersion: 1,
    publishedConfig: { pages: [{ slug: "/home", sections: [{ id: "s1" }] }] },
    websiteConfig: { pages: [{ slug: "/home", sections: [{ id: "s1" }] }] },
    settings: { maintenance: { enabled: false } },
    ...over,
  }) as never;

const live = (version = 1) => ({ version, status: "LIVE" }) as never;

describe("statusFrom — DRAFT, LIVE, PAUSED, FAILED and nothing invented", () => {
  it("is DRAFT before anything has been published", () => {
    assert.equal(statusFrom(college({ publishedVersion: 0 }), null, false), "DRAFT");
  });

  it("is LIVE once published and serving", () => {
    assert.equal(statusFrom(college(), live(), false), "LIVE");
  });

  /**
   * The case that started this. Maintenance mode is set two tabs away from the
   * publish screen, and with it on, a published site with a verified domain
   * shows every visitor a maintenance page. PAUSED is that state having a name.
   */
  it("is PAUSED when maintenance mode is hiding a published site", () => {
    const paused = college({ settings: { maintenance: { enabled: true } } });
    assert.equal(statusFrom(paused, live(), false), "PAUSED");
  });

  it("is FAILED when the last publish failed and nothing is live", () => {
    assert.equal(statusFrom(college(), null, true), "FAILED");
  });

  /**
   * A failure after a good publish does not take the site down — the previous
   * version is still being served, so reporting FAILED would tell a tenant
   * their site is off when it is up.
   */
  it("stays LIVE when a later publish failed but a good version is still serving", () => {
    assert.equal(statusFrom(college(), live(), true), "LIVE");
  });
});

describe("preconditionsFor — six answers, each from real state", () => {
  const keys = (c: never, userId = "u1", l: never | null = live()) =>
    Object.fromEntries(preconditionsFor(c, userId, l).map((p) => [p.key, p.ok]));

  it("passes everything for a published, serving, owned site", () => {
    const all = keys(college());
    assert.deepEqual(all, {
      ownership: true,
      build: true,
      deployment: true,
      linkage: true,
      domain: true,
      serving: true,
    });
  });

  /** The access check, doubling as a precondition. */
  it("fails ownership for a different user", () => {
    assert.equal(keys(college(), "somebody-else").ownership, false);
  });

  it("fails build when nothing is published", () => {
    assert.equal(keys(college({ publishedVersion: 0, publishedConfig: null }), "u1", null).build, false);
  });

  /** A published config with no sections is an empty site, not a site. */
  it("fails build when the published version has no sections", () => {
    const empty = college({ publishedConfig: { pages: [{ slug: "/home", sections: [] }] } });
    assert.equal(keys(empty).build, false);
  });

  /**
   * The consistency check this whole design exists for: a deployment row
   * claiming LIVE for a version the tenant document no longer serves. It cannot
   * be detected from either record alone.
   */
  it("fails linkage when the live deployment is not the served version", () => {
    assert.equal(keys(college({ publishedVersion: 7 }), "u1", live(5)).linkage, false);
  });

  /** No custom domain is not a failure — the platform subdomain always works. */
  it("passes domain when there is no custom domain at all", () => {
    assert.equal(keys(college({ domains: [] })).domain, true);
  });

  it("fails domain when one is added but none verified", () => {
    const pending = college({ domains: [{ hostname: "x.test", status: "PENDING_VERIFICATION" }] });
    assert.equal(keys(pending).domain, false);
  });

  it("passes domain on a verified one, not only an active one", () => {
    const verified = college({ domains: [{ hostname: "x.test", status: "VERIFIED" }] });
    assert.equal(keys(verified).domain, true);
  });

  it("fails serving under maintenance mode, and says so", () => {
    const paused = college({ settings: { maintenance: { enabled: true } } });
    const rows = preconditionsFor(paused, "u1", live());
    const serving = rows.find((p) => p.key === "serving")!;
    assert.equal(serving.ok, false);
    assert.match(String(serving.detail), /maintenance/i);
  });
});

describe("liveUrlFor — the address to hand somebody", () => {
  const original = process.env.ROOT_DOMAIN;
  beforeEach(() => {
    process.env.ROOT_DOMAIN = "webxite.org";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.ROOT_DOMAIN;
    else process.env.ROOT_DOMAIN = original;
  });

  it("falls back to the platform subdomain", () => {
    const { url, target } = liveUrlFor({ subdomain: "greenfield", domains: [] });
    assert.equal(url, "https://greenfield.webxite.org");
    assert.equal(target, "platform");
  });

  it("prefers a servable custom domain", () => {
    const { url, target } = liveUrlFor({
      subdomain: "greenfield",
      domains: [{ hostname: "g7a.in", status: "VERIFIED" }],
    });
    assert.equal(url, "https://g7a.in");
    assert.equal(target, "g7a.in");
  });

  /** The one the tenant marked, not whichever happens to sort first. */
  it("prefers the primary domain among several", () => {
    const { url } = liveUrlFor({
      subdomain: "greenfield",
      domains: [
        { hostname: "old.test", status: "ACTIVE" },
        { hostname: "new.test", status: "ACTIVE", isPrimary: true },
      ],
    });
    assert.equal(url, "https://new.test");
  });

  /** An unverified domain is not an address. */
  it("ignores a domain that is not servable", () => {
    const { url } = liveUrlFor({
      subdomain: "greenfield",
      domains: [{ hostname: "pending.test", status: "PENDING_VERIFICATION" }],
    });
    assert.equal(url, "https://greenfield.webxite.org");
  });
});
