/**
 * The subscription endpoints, against a real booted server.
 *
 * What the unit tests cannot reach: whether the routes are actually mounted,
 * whether the raw body survives the JSON parser well enough for the webhook
 * HMAC to verify, and whether an unauthenticated caller is refused before any
 * of it runs. Those are wiring, and wiring only fails in a running process.
 *
 * Razorpay itself is never called. Every test here is either a rejection (which
 * happens before any outbound request) or a webhook (which Razorpay initiates,
 * not us), so the whole file runs with fabricated keys and no network. The
 * paths that *do* call Razorpay — creating a subscription, verifying a real
 * payment — cannot be tested without live test credentials and are listed as
 * manual steps in RAZORPAY.md.
 *
 *   node scripts/test-subscription-e2e.mjs
 */
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";

import { MongoMemoryServer } from "mongodb-memory-server";

const PORT = 4113;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://localhost:3000";

const KEY_SECRET = "e2e_key_secret_at_least_32_characters_long";
const WEBHOOK_SECRET = "e2e_webhook_secret_not_a_real_one_at_all";
const WEBHOOK_PATH = "/api/v1/billing/razorpay/webhook";

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sign = (body, secret = WEBHOOK_SECRET) =>
  createHmac("sha256", secret).update(body).digest("hex");

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/* ── Boot ──────────────────────────────────────────────────────────────── */

const mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 120_000 } });

const server = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["tsx", "src/server.ts"],
  {
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      MONGODB_URI: mongo.getUri("xite_subscription_e2e"),
      SESSION_SECRET: "e2e-session-secret-value-at-least-32-chars-long",
      ADMIN_SESSION_SECRET: "e2e-admin-secret-value-at-least-32-characters",
      CORS_ORIGINS: ORIGIN,
      ENABLE_RATE_LIMIT: "false",
      // Fabricated, and never used to reach Razorpay: nothing in this file
      // takes a path that makes an outbound call.
      RAZORPAY_KEY_ID: "rzp_test_e2e_fake",
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_PLAN_ID: "plan_e2e_fake",
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
      // AUTH_DISABLED would mint an open-access session and make the 401 tests
      // below pass for the wrong reason.
      AUTH_DISABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  },
);

const log = [];
server.stdout.on("data", (d) => log.push(String(d)));
server.stderr.on("data", (d) => log.push(String(d)));

if (!(await waitForServer())) {
  console.error("Server did not start.\n" + log.join(""));
  server.kill();
  await mongo.stop();
  process.exit(1);
}

/* ── Tests ─────────────────────────────────────────────────────────────── */

try {
  console.log("\nAuthentication — every tenant route is behind a session");
  for (const [method, path] of [
    ["GET", "/api/v1/billing/subscription"],
    ["POST", "/api/v1/billing/subscription"],
    ["POST", "/api/v1/billing/subscription/verify"],
    ["POST", "/api/v1/billing/subscription/refresh"],
    ["POST", "/api/v1/billing/subscription/cancel"],
  ]) {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
    check(`${method} ${path} → 401 without a session`, response.status === 401, `got ${response.status}`);
  }

  const adminResponse = await fetch(`${BASE}/api/v1/admin/subscriptions`);
  check(
    "GET /api/v1/admin/subscriptions → 401 without an admin session",
    adminResponse.status === 401,
    `got ${adminResponse.status}`,
  );

  console.log("\nWebhook — the one unauthenticated route, so the signature is everything");

  const event = JSON.stringify({
    event: "subscription.activated",
    payload: { subscription: { entity: { id: "sub_e2e_unknown", status: "active" } } },
  });

  {
    const response = await fetch(`${BASE}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: event,
    });
    check("unsigned webhook → 400", response.status === 400, `got ${response.status}`);
  }

  {
    const response = await fetch(`${BASE}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-razorpay-signature": "deadbeef" },
      body: event,
    });
    check("garbage signature → 400", response.status === 400, `got ${response.status}`);
  }

  {
    // Signed with the key secret rather than the webhook secret: a real
    // configuration mistake, and it must not authenticate anything.
    const response = await fetch(`${BASE}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": sign(event, KEY_SECRET),
      },
      body: event,
    });
    check("signed with the wrong secret → 400", response.status === 400, `got ${response.status}`);
  }

  {
    const tampered = event.replace("sub_e2e_unknown", "sub_e2e_tampered");
    const response = await fetch(`${BASE}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": sign(event),
      },
      body: tampered,
    });
    check("body altered after signing → 400", response.status === 400, `got ${response.status}`);
  }

  {
    /*
     * The test this whole file exists for. A valid signature over the raw bytes
     * has to verify *through Express's JSON parser* — if `rawBody` is not
     * captured, or is re-serialised anywhere, this is the case that fails while
     * every unit test still passes.
     */
    const response = await fetch(`${BASE}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": sign(event),
        "x-razorpay-event-id": "evt_e2e_001",
      },
      body: event,
    });
    const payload = await response.json().catch(() => null);
    check(
      "correctly signed webhook → 200 (raw body survived the JSON parser)",
      response.status === 200 && payload?.received === true,
      `got ${response.status} ${JSON.stringify(payload)}`,
    );
    check(
      "first delivery is not reported as a duplicate",
      payload?.duplicate === false,
      JSON.stringify(payload),
    );
  }

  {
    // Razorpay redelivers after a timeout even when the first attempt worked.
    const response = await fetch(`${BASE}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": sign(event),
        "x-razorpay-event-id": "evt_e2e_001",
      },
      body: event,
    });
    const payload = await response.json().catch(() => null);
    check(
      "redelivery of the same event id → 200 and duplicate: true",
      response.status === 200 && payload?.duplicate === true,
      `got ${response.status} ${JSON.stringify(payload)}`,
    );
  }

  {
    // A signed event this deployment does not act on is still acknowledged, or
    // Razorpay retries it until it gives up.
    const other = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_e2e" } } },
    });
    const response = await fetch(`${BASE}${WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-razorpay-signature": sign(other),
        "x-razorpay-event-id": "evt_e2e_002",
      },
      body: other,
    });
    check("an event we do not handle is still acknowledged → 200", response.status === 200, `got ${response.status}`);
  }

  console.log("\nSecrets never leave the server");
  {
    const response = await fetch(`${BASE}/health`);
    const text = await response.text();
    check("the key secret is not in /health", !text.includes(KEY_SECRET));
    check("the webhook secret is not in /health", !text.includes(WEBHOOK_SECRET));
  }
  {
    const response = await fetch(`${BASE}/openapi.json`);
    const text = await response.text();
    check("the key secret is not in the OpenAPI document", !text.includes(KEY_SECRET));
    check(
      "the subscription endpoints are documented",
      text.includes("/api/v1/billing/subscription"),
    );
  }
} finally {
  server.kill();
  await mongo.stop();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error("\nServer log:\n" + log.join(""));
}
process.exit(failed > 0 ? 1 : 0);
