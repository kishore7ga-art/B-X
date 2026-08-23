import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  accessRequestSchema,
  activatePasswordSchema,
  listQuerySchema,
  MIN_ACCOUNT_PASSWORD_LENGTH,
  PASSWORD_COST,
} from "./access-service";

/**
 * Regression tests for the access-request flow, which is the only public write
 * on this service and the only path that creates a tenant.
 */

describe("accessRequestSchema", () => {
  const valid = { name: "Ada", email: "ada@college.edu" };

  it("accepts a request with no password", () => {
    assert.equal(accessRequestSchema.safeParse(valid).success, true);
  });

  it("treats an empty password as absent rather than as a one-character one", () => {
    const parsed = accessRequestSchema.safeParse({ ...valid, password: "" });
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && parsed.data.password, undefined);
  });

  /**
   * This field is not cosmetic: `approveAccessRequest` copies its hash straight
   * onto the created account, so whatever passes here becomes a real password on
   * a real tenant. It previously had no minimum at all.
   */
  it("enforces the account password floor on the public form", () => {
    assert.equal(accessRequestSchema.safeParse({ ...valid, password: "x" }).success, false);
    assert.equal(
      accessRequestSchema.safeParse({ ...valid, password: "a".repeat(MIN_ACCOUNT_PASSWORD_LENGTH - 1) }).success,
      false,
    );
    assert.equal(
      accessRequestSchema.safeParse({ ...valid, password: "a".repeat(MIN_ACCOUNT_PASSWORD_LENGTH) }).success,
      true,
    );
  });

  it("bounds every free-text field", () => {
    assert.equal(accessRequestSchema.safeParse({ ...valid, name: "n".repeat(121) }).success, false);
    assert.equal(accessRequestSchema.safeParse({ ...valid, organization: "o".repeat(161) }).success, false);
    assert.equal(accessRequestSchema.safeParse({ ...valid, message: "m".repeat(2001) }).success, false);
    assert.equal(accessRequestSchema.safeParse({ ...valid, password: "p".repeat(201) }).success, false);
  });

  it("lowercases and trims the email", () => {
    const parsed = accessRequestSchema.safeParse({ name: "Ada", email: "  ADA@College.EDU  " });
    assert.equal(parsed.success && parsed.data.email, "ada@college.edu");
  });

  /**
   * `express.json()` hands the route whatever JSON was posted, so an operator
   * object can arrive in any field. Zod's string check is what keeps it out of
   * `AccessRequest.findOne({ applicantEmail })`.
   */
  it("rejects MongoDB operator objects in every field", () => {
    for (const field of ["name", "email", "password", "organization", "message"]) {
      const body = { ...valid, [field]: { $ne: null } };
      assert.equal(
        accessRequestSchema.safeParse(body).success,
        false,
        `${field} accepted an operator object`,
      );
    }
  });
});

describe("activatePasswordSchema", () => {
  const token = "a".repeat(64);

  it("requires a 64-hex activation token", () => {
    assert.equal(activatePasswordSchema.safeParse({ token, password: "a".repeat(12) }).success, true);
    assert.equal(activatePasswordSchema.safeParse({ token: "short", password: "a".repeat(12) }).success, false);
    assert.equal(
      activatePasswordSchema.safeParse({ token: "Z".repeat(64), password: "a".repeat(12) }).success,
      false,
      "non-hex characters must be rejected before the token reaches a query",
    );
    assert.equal(
      activatePasswordSchema.safeParse({ token: { $ne: null }, password: "a".repeat(12) }).success,
      false,
    );
  });

  it("holds activation to the same password floor as everywhere else", () => {
    assert.equal(
      activatePasswordSchema.safeParse({ token, password: "a".repeat(MIN_ACCOUNT_PASSWORD_LENGTH - 1) }).success,
      false,
    );
    assert.equal(
      activatePasswordSchema.safeParse({ token, password: "a".repeat(MIN_ACCOUNT_PASSWORD_LENGTH) }).success,
      true,
    );
  });
});

describe("listQuerySchema", () => {
  it("allows only the four known statuses, defaulting to ALL", () => {
    assert.equal(listQuerySchema.parse({}).status, "ALL");
    assert.equal(listQuerySchema.parse({ status: "PENDING" }).status, "PENDING");
    assert.equal(listQuerySchema.safeParse({ status: "DROP" }).success, false);
    // The filter is spread straight into `AccessRequest.find(filter)`.
    assert.equal(listQuerySchema.safeParse({ status: { $ne: "REJECTED" } }).success, false);
  });
});

describe("password work factor", () => {
  it("is 12 everywhere, not 8 on the path most accounts take", () => {
    assert.equal(PASSWORD_COST, 12);
  });
});

describe("the pre-approval hijack stays closed", () => {
  /**
   * `submitAccessRequest` is unauthenticated. It used to overwrite an existing
   * PENDING row's `passwordHash` with whatever a second caller sent, so anyone
   * could aim a password at somebody else's queued application and have the
   * Super Admin provision the account with it.
   *
   * This asserts on the source because the behaviour needs a live database to
   * exercise, and the property worth locking is narrow and textual: that branch
   * must not assign to `pending.passwordHash`.
   */
  it("does not write to a pending request it did not create", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, "./access-service.ts"), "utf8");

    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

    assert.ok(
      !/pending\.passwordHash\s*=/.test(code),
      "submitAccessRequest must not overwrite a queued applicant's password hash",
    );
    assert.ok(
      !/pending\.applicantName\s*=/.test(code),
      "submitAccessRequest must not overwrite a queued applicant's name",
    );
    assert.ok(
      !/pending\.save\(\)/.test(code),
      "an unauthenticated caller must not be able to mutate an existing request",
    );
  });

  /**
   * The Google activation path verified nothing: a local stub shadowed the real
   * verifier and returned its own argument as the identity.
   */
  it("verifies Google identity tokens with the real verifier", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const source = await readFile(join(here, "./access-service.ts"), "utf8");

    assert.match(
      source,
      /import \{ verifyGoogleIdToken \} from "@\/google-identity"/,
      "activation must use the JWKS-backed verifier",
    );

    // Comments stripped first: the docblock that replaced the stub quotes the
    // stub's body verbatim, which is the point of it and would otherwise fail
    // the very check it documents.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.ok(
      !/function verifyGoogleIdToken/.test(code),
      "a local verifyGoogleIdToken would shadow the real one again",
    );
  });
});
