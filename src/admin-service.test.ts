import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { adminLoginSchema } from "./admin-service";

/**
 * Regression tests for the Super Admin backdoor.
 *
 * `adminLogin` itself needs a live MongoDB connection to test end to end, so
 * these cover the parts that are decidable without one — the schema, and a
 * static read of the module source for the literals that made the backdoor.
 *
 * The source assertions look unusual and they are deliberate. The vulnerability
 * was not a subtle logic error: it was the string "2008" compared against the
 * submitted password in three places, one of which minted a SUPER_ADMIN account
 * for any email address that presented it. A test that fails the moment such a
 * comparison reappears is worth more here than a mock of the database, because
 * the failure mode is somebody re-adding a convenience during a debugging
 * session, not the logic drifting.
 */
describe("adminLoginSchema", () => {
  it("requires a password", () => {
    assert.equal(adminLoginSchema.safeParse({}).success, false);
    assert.equal(adminLoginSchema.safeParse({ password: "" }).success, false);
  });

  it("normalises the email and rejects a malformed one", () => {
    const ok = adminLoginSchema.safeParse({ email: "  Admin@Example.COM ", password: "x" });
    assert.equal(ok.success, true);
    assert.equal(ok.success && ok.data.email, "admin@example.com");

    assert.equal(adminLoginSchema.safeParse({ email: "not-an-email", password: "x" }).success, false);
  });

  it("accepts only a six-digit TOTP code", () => {
    assert.equal(adminLoginSchema.safeParse({ password: "x", token: "123456" }).success, true);
    assert.equal(adminLoginSchema.safeParse({ password: "x", token: "12345" }).success, false);
    assert.equal(adminLoginSchema.safeParse({ password: "x", token: "abcdef" }).success, false);
  });

  /**
   * A Mongo operator object where a string is expected.
   *
   * `AdminUser.findOne({ email })` with `{ $ne: null }` in that slot matches the
   * first administrator in the collection. Zod's `z.string()` is what stops the
   * object ever reaching the query, so it is worth a test of its own rather than
   * being assumed from the type annotation — the annotation is erased at runtime
   * and the body arrives from `express.json()`.
   */
  it("rejects a MongoDB operator object in place of a credential", () => {
    assert.equal(adminLoginSchema.safeParse({ email: { $ne: null }, password: "x" }).success, false);
    assert.equal(adminLoginSchema.safeParse({ email: "a@b.com", password: { $ne: null } }).success, false);
    assert.equal(adminLoginSchema.safeParse({ email: "a@b.com", password: "x", token: { $ne: null } }).success, false);
  });
});

describe("no credential is compiled into the admin auth path", () => {
  const readSource = async (path: string) => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    return readFile(join(here, path), "utf8");
  };

  /** Comments describing the removed backdoor are fine; a comparison is not. */
  const codeOnly = (source: string) =>
    source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

  it("adminLogin no longer compares against a hardcoded password", async () => {
    const code = codeOnly(await readSource("./admin-service.ts"));
    assert.ok(!/"2008"|'2008'/.test(code), "a literal 2008 comparison is back in admin-service.ts");
    assert.ok(
      !/ADMIN_BOOTSTRAP_PASSWORD/.test(code),
      "adminLogin must not accept the bootstrap password as a standing credential",
    );
    assert.ok(
      !/super-admin-root/.test(code),
      "the synthetic super-admin session must not be reinstated",
    );
    assert.ok(
      !/AdminUser\.create/.test(code),
      "the login path must not provision administrators",
    );
  });

  it("bootstrap no longer carries a committed default password", async () => {
    const code = codeOnly(await readSource("./admin-bootstrap.ts"));
    // The published-password blocklist legitimately contains these literals, so
    // the check is that they are not being *assigned* as a default.
    assert.ok(
      !/password:\s*"2008"/.test(code),
      "the committed default admin password is back in admin-bootstrap.ts",
    );
  });

  it("no committed account password survives in access-service", async () => {
    const code = codeOnly(await readSource("./access-service.ts"));
    assert.ok(!/"college123"|'college123'/.test(code), "the default account password is back");
  });
});
