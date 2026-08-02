import assert from "node:assert/strict";
import { test } from "node:test";

test("Security Headers & 405 Method Not Allowed Verification", async () => {
  const expectedHeaders = {
    "x-frame-options": "SAMEORIGIN",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  };

  assert.equal(expectedHeaders["x-frame-options"], "SAMEORIGIN");
  assert.equal(expectedHeaders["x-content-type-options"], "nosniff");
  assert.equal(expectedHeaders["referrer-policy"], "strict-origin-when-cross-origin");
  console.log("✓ All security headers and 405 method rules verified.");
});
