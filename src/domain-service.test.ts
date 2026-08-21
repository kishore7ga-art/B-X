import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __testing } from "@/domain-service";

const { normalizeHostname, assertNotPlatformHost, isApex } = __testing;

const rejects = (input: unknown, because: string) => {
  assert.throws(() => normalizeHostname(input), /./, `expected "${String(input)}" to be rejected: ${because}`);
};

describe("normalizeHostname — what a tenant typed vs what a Host header carries", () => {
  it("accepts a bare hostname unchanged", () => {
    assert.equal(normalizeHostname("www.college.edu"), "www.college.edu");
  });

  it("lowercases and trims", () => {
    assert.equal(normalizeHostname("  WWW.College.EDU  "), "www.college.edu");
  });

  // People paste what is in their address bar. Storing that verbatim gives a
  // value no Host header can ever match, so the domain sits PENDING forever.
  it("strips a scheme", () => {
    assert.equal(normalizeHostname("https://www.college.edu"), "www.college.edu");
    assert.equal(normalizeHostname("http://college.edu"), "college.edu");
  });

  it("strips a path and query", () => {
    assert.equal(normalizeHostname("https://college.edu/admissions?year=2026"), "college.edu");
  });

  it("strips a port", () => {
    assert.equal(normalizeHostname("college.edu:8443"), "college.edu");
  });

  it("strips a trailing dot from a fully-qualified name", () => {
    assert.equal(normalizeHostname("college.edu."), "college.edu");
  });

  it("strips userinfo rather than storing it", () => {
    assert.equal(normalizeHostname("https://user:pass@college.edu"), "college.edu");
  });

  it("rejects a single label", () => {
    rejects("college", "no extension means it can never resolve");
  });

  it("rejects empty and non-string input", () => {
    rejects("", "nothing was entered");
    rejects("   ", "whitespace only");
    rejects(undefined, "missing field");
    rejects(null, "null field");
    rejects(42, "not a string");
  });

  it("rejects labels with characters DNS does not allow", () => {
    rejects("col lege.edu", "space");
    rejects("college_site.edu", "underscore");
    rejects("-college.edu", "leading hyphen");
    rejects("college-.edu", "trailing hyphen");
  });

  it("rejects a name longer than 253 characters", () => {
    rejects(`${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(20)}.edu`, "too long");
  });
});

describe("assertNotPlatformHost — a tenant cannot claim the platform's own names", () => {
  it("refuses the root domain", () => {
    assert.throws(() => assertNotPlatformHost("xite.co.in"), /belongs to the platform/);
  });

  it("refuses any platform subdomain", () => {
    for (const host of ["admin.xite.co.in", "api.xite.co.in", "anything.xite.co.in"]) {
      assert.throws(() => assertNotPlatformHost(host), /belongs to the platform/, host);
    }
  });

  // The distinction the CORS check in server.ts already documents: a substring
  // test would admit this, and it is a domain anyone can register.
  it("allows a domain that merely contains the root domain", () => {
    assert.doesNotThrow(() => assertNotPlatformHost("xite.co.in.attacker.com"));
  });

  it("refuses localhost", () => {
    assert.throws(() => assertNotPlatformHost("localhost"), /localhost/);
    assert.throws(() => assertNotPlatformHost("app.localhost"), /localhost/);
  });

  it("allows an ordinary tenant-owned domain", () => {
    assert.doesNotThrow(() => assertNotPlatformHost("www.madrasengineering.edu.in"));
    assert.doesNotThrow(() => assertNotPlatformHost("college.edu"));
  });
});

describe("isApex — which DNS record the tenant is told to create", () => {
  it("treats a two-label name as apex", () => {
    assert.equal(isApex("college.edu"), true);
  });

  it("treats a subdomain as not apex", () => {
    assert.equal(isApex("www.college.edu"), false);
    assert.equal(isApex("sites.www.college.edu"), false);
  });

  // A three-label public suffix reads as a subdomain here. That is a known
  // limitation: without a public-suffix list, `college.edu.in` cannot be told
  // apart from `www.college.edu`. The consequence is that such a tenant is
  // offered a CNAME, which their provider may refuse at the apex — they can
  // still use the A record path once CUSTOM_DOMAIN_APEX_IP is configured.
  it("misreads a multi-part public suffix as a subdomain (documented limitation)", () => {
    assert.equal(isApex("college.edu.in"), false);
  });
});
