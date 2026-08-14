import assert from "node:assert/strict";
import { test } from "node:test";

const BASE_URL = process.env.TEST_API_BASE ?? "http://localhost:4000";

test("Sprint M7-A Post-Deploy CUJ-001 Smoke Test", async () => {
  // 1. Health check
  const healthRes = await fetch(`${BASE_URL}/api/health`);
  assert.equal(healthRes.status, 200);
  const healthJson = await healthRes.json();
  assert.equal(healthJson.status, "ok");

  // 2. Flow Health Heartbeat
  const flowRes = await fetch(`${BASE_URL}/api/v1/system/flow-health`);
  assert.equal(flowRes.status, 200);
  const flowJson = await flowRes.json();
  assert.equal(flowJson.accessRequest, "ok");
  assert.equal(flowJson.e2eSuite, "93/93");

  // 3. Tracing Headers Check
  const optRes = await fetch(`${BASE_URL}/api/v1/access-requests`, { method: "OPTIONS" });
  assert.ok(optRes.headers.get("x-request-id"), "Missing x-request-id header");
  assert.ok(optRes.headers.get("x-tenant-id"), "Missing x-tenant-id header");
  assert.ok(optRes.headers.get("x-flow-stage"), "Missing x-flow-stage header");

  console.log("✓ Post-deploy CUJ-001 smoke test passed with 100% verification.");
});
