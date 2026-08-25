import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isPublicAddress, resolvesToPublicAddress } from "@/lib/net/public-address";

/**
 * The guard between a tenant-supplied hostname and a socket.
 *
 * Domain verification has to make a real request to a name the tenant chose,
 * from inside our network. Every case below is a way that has been used to turn
 * exactly that into a request against infrastructure the tenant cannot reach
 * directly.
 */

describe("isPublicAddress — IPv4", () => {
  const blocked: [string, string][] = [
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback, whole /8"],
    ["0.0.0.0", "this network"],
    ["10.0.0.5", "RFC1918"],
    ["172.16.0.1", "RFC1918, low edge"],
    ["172.31.255.254", "RFC1918, high edge"],
    ["192.168.1.1", "RFC1918"],
    ["169.254.169.254", "cloud metadata"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["192.0.2.1", "TEST-NET-1"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "broadcast"],
  ];

  for (const [address, why] of blocked) {
    it(`refuses ${address} (${why})`, () => {
      assert.equal(isPublicAddress(address), false);
    });
  }

  const allowed = ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "192.167.0.1", "203.1.0.1"];
  for (const address of allowed) {
    it(`allows ${address}`, () => {
      assert.equal(isPublicAddress(address), true);
    });
  }

  it("refuses 172.15 and 172.32 correctly — the private block is 16–31 only", () => {
    // A prefix test on "172." would refuse both of these, and a test on
    // "172.1" would let 172.16 through. Hence arithmetic, not strings.
    assert.equal(isPublicAddress("172.15.0.1"), true);
    assert.equal(isPublicAddress("172.16.0.1"), false);
    assert.equal(isPublicAddress("172.31.0.1"), false);
    assert.equal(isPublicAddress("172.32.0.1"), true);
  });
});

describe("isPublicAddress — IPv6", () => {
  for (const address of [
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
  ]) {
    it(`refuses ${address}`, () => {
      assert.equal(isPublicAddress(address), false);
    });
  }

  it("judges an IPv4-mapped address by the IPv4 rules", () => {
    // `::ffff:10.0.0.1` reaches the private v4 host. Treating it as "some IPv6
    // address, looks fine" is how this check gets walked around.
    assert.equal(isPublicAddress("::ffff:8.8.8.8"), true);
    assert.equal(isPublicAddress("::ffff:192.168.1.1"), false);
  });

  it("allows an ordinary public v6 address", () => {
    assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  });
});

describe("isPublicAddress — anything that is not an address", () => {
  for (const value of ["", "not-an-ip", "999.1.1.1", "1.2.3", "1.2.3.4.5", "0x7f.0.0.1"]) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      assert.equal(isPublicAddress(value), false);
    });
  }
});

describe("resolvesToPublicAddress", () => {
  it("refuses a literal loopback address without resolving anything", async () => {
    // `127.0.0.1` passes an LDH label check — four labels, each alphanumeric —
    // so it reaches this guard as an ordinary "domain" name.
    const result = await resolvesToPublicAddress("127.0.0.1");
    assert.equal(result.allowed, false);
    assert.match((result as { reason: string }).reason, /not a public address/);
  });

  it("refuses a literal metadata address", async () => {
    const result = await resolvesToPublicAddress("169.254.169.254");
    assert.equal(result.allowed, false);
  });

  it("allows a literal public address", async () => {
    const result = await resolvesToPublicAddress("8.8.8.8");
    assert.equal(result.allowed, true);
  });

  it("refuses a name that does not resolve, rather than allowing it", async () => {
    // "We could not tell" must not read as "safe".
    const result = await resolvesToPublicAddress(
      "no-such-host.invalid-tld-that-cannot-exist",
      2000,
    );
    assert.equal(result.allowed, false);
    assert.match((result as { reason: string }).reason, /does not resolve/);
  });

  it("refuses localhost, which resolves to loopback", async () => {
    const result = await resolvesToPublicAddress("localhost", 2000);
    assert.equal(result.allowed, false);
  });
});
