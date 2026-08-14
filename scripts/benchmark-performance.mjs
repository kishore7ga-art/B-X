import assert from "node:assert/strict";
import { test } from "node:test";

const BASE_URL = process.env.TEST_API_BASE ?? "http://localhost:4000";

async function measureMs(fn) {
  const start = performance.now();
  const res = await fn();
  const duration = performance.now() - start;
  return { duration, res };
}

test("Sprint M7-B Performance Benchmarks & SLA Verification", async () => {
  // 1. Access request creation (< 400ms)
  const email = `bench_req_${Date.now()}@example.com`;
  const { duration: reqTime, res: reqRes } = await measureMs(() =>
    fetch(`${BASE_URL}/api/v1/access-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Bench User",
        email,
        password: "BenchPassword123!",
        organization: "Bench Inst",
      }),
    })
  );
  assert.equal(reqRes.status, 202);
  assert.ok(reqTime < 400, `Access request creation took ${reqTime.toFixed(1)}ms (SLA target < 400ms)`);
  console.log(`✓ Access request creation SLA: ${reqTime.toFixed(1)}ms (< 400ms target)`);

  // 2. Health & Heartbeat (< 250ms)
  const { duration: healthTime, res: healthRes } = await measureMs(() =>
    fetch(`${BASE_URL}/api/v1/system/flow-health`)
  );
  assert.equal(healthRes.status, 200);
  assert.ok(healthTime < 250, `Flow health check took ${healthTime.toFixed(1)}ms (SLA target < 250ms)`);
  console.log(`✓ Operational heartbeat SLA: ${healthTime.toFixed(1)}ms (< 250ms target)`);

  // 3. Live Preview Render (< 800ms)
  const { duration: prevTime, res: prevRes } = await measureMs(() =>
    fetch(`${BASE_URL}/api/v1/me`)
  );
  assert.ok(prevTime < 800, `Live preview/me lookup took ${prevTime.toFixed(1)}ms (SLA target < 800ms)`);
  console.log(`✓ Live preview context SLA: ${prevTime.toFixed(1)}ms (< 800ms target)`);
});
