import assert from "node:assert/strict";
import mongoose from "mongoose";
import dns from "node:dns";

try {
  dns.setDefaultResultOrder("ipv4first");
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (e) {}

const BASE_URL = process.env.TEST_API_BASE ?? "http://localhost:4000";
/**
 * From the environment, never from this file.
 *
 * A live connection string with a working username and password was hardcoded
 * here, in a repository that was public — read/write access to every tenant's
 * data, bypassing the API and every check in it. Rotating the password is what
 * fixed the exposure; this is what stops it coming back.
 */
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error("Set MONGODB_URI in the environment before running this script.");
  process.exit(2);
}

async function verifyEditorContract() {
  console.log("==========================================================");
  console.log("   XITE EDITOR API CONTRACT VERIFICATION (PROD FLOW)   ");
  console.log("==========================================================");

  await mongoose.connect(MONGODB_URI);
  console.log("✓ Connected to MongoDB Atlas: college_saas");

  const testEmail = `editor-contract-${Date.now()}@testuniv.edu`;
  const subdomain = `editor-contract-${Date.now()}`;

  // 1. Create access request and approve
  const reqRes = await fetch(`${BASE_URL}/api/v1/access-requests`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Editor Admin",
      email: testEmail,
      organization: "Editor Contract Univ",
      password: "TestPassword123!",
      subdomain,
    }),
  });
  assert.equal(reqRes.status, 202);

  // Admin login to approve
  const adminLoginRes = await fetch(`${BASE_URL}/api/v1/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@xite.co.in", password: "2008" }),
  });
  const adminCookie = adminLoginRes.headers.get("set-cookie") || "";

  let reqDoc = await mongoose.connection.db.collection("access_requests").findOne({ applicantEmail: testEmail });
  if (!reqDoc) {
    reqDoc = await mongoose.connection.db.collection("accessrequests").findOne({ applicantEmail: testEmail });
  }
  assert.ok(reqDoc);

  const approveRes = await fetch(`${BASE_URL}/api/v1/admin/access-requests/${reqDoc._id}/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(adminCookie ? { Cookie: adminCookie } : {}),
    },
  });
  assert.equal(approveRes.status, 200);
  console.log(`✓ Tenant created with subdomain: ${subdomain}`);

  // 2. Login as Tenant College Admin to get session cookie
  const userLoginRes = await fetch(`${BASE_URL}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: "TestPassword123!" }),
  });
  assert.equal(userLoginRes.status, 200);
  const collegeCookie = userLoginRes.headers.get("set-cookie") || "";
  assert.ok(collegeCookie, "Set-Cookie header must be returned on tenant login");
  console.log(`✓ Authenticated Tenant session cookie obtained: ${collegeCookie.substring(0, 30)}...`);

  // 3. EDITOR LOAD: GET /api/v1/my-website (Authenticated Editor Endpoint)
  console.log("\n--- VERIFYING EDITOR LOAD ENDPOINT ---");
  const editorLoadRes = await fetch(`${BASE_URL}/api/v1/my-website`, {
    headers: { Cookie: collegeCookie },
  });
  console.log(`Endpoint: GET ${BASE_URL}/api/v1/my-website`);
  console.log(`Status: ${editorLoadRes.status}`);
  assert.equal(editorLoadRes.status, 200);
  const editorConfig = await editorLoadRes.json();
  assert.ok(editorConfig.pages, "Editor GET /api/v1/my-website must return websiteConfig");
  console.log(`✓ GET /api/v1/my-website returned tenant websiteConfig (${editorConfig.pages.length} pages)`);

  // 4. EDITOR SAVE: PUT /api/v1/my-website (Authenticated Save Endpoint)
  console.log("\n--- VERIFYING EDITOR SAVE ENDPOINT ---");
  const modifiedConfig = {
    ...editorConfig,
    pages: editorConfig.pages.map((p, i) =>
      i === 0
        ? {
            ...p,
            sections: [
              ...p.sections,
              {
                id: "contract-test-sec-01",
                title: "Contract Verification Section",
                category: "hero",
                code: "<section id='contract-test-sec-01'><h1>Contract Verified</h1></section>",
              },
            ],
          }
        : p
    ),
  };

  const editorSaveRes = await fetch(`${BASE_URL}/api/v1/my-website`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Cookie: collegeCookie,
    },
    body: JSON.stringify(modifiedConfig),
  });
  console.log(`Endpoint: PUT ${BASE_URL}/api/v1/my-website`);
  console.log(`Status: ${editorSaveRes.status}`);
  assert.equal(editorSaveRes.status, 200);

  // Verify MongoDB colleges collection changed
  const collegeDoc = await mongoose.connection.db.collection("colleges").findOne({ "users.email": testEmail });
  assert.ok(collegeDoc, "College document must exist in MongoDB");
  const actualSubdomain = collegeDoc.subdomain;
  const savedSec = collegeDoc.websiteConfig.pages[0].sections.find((s) => s.id === "contract-test-sec-01");
  assert.ok(savedSec, "Modified section must exist in MongoDB colleges.websiteConfig");
  console.log(`✓ PUT /api/v1/my-website successfully persisted to MongoDB colleges.websiteConfig (subdomain: ${actualSubdomain})`);

  // 5. LIVE WEBSITE READ: GET /api/v1/public/site/:subdomain (Unauthenticated Public Endpoint)
  console.log("\n--- VERIFYING PUBLIC LIVE WEBSITE ENDPOINT ---");
  const liveRes = await fetch(`${BASE_URL}/api/v1/public/site/${actualSubdomain}`);
  console.log(`Endpoint: GET ${BASE_URL}/api/v1/public/site/${subdomain}`);
  console.log(`Status: ${liveRes.status}`);
  assert.equal(liveRes.status, 200);
  const liveConfig = await liveRes.json();
  const liveSec = liveConfig.pages[0].sections.find((s) => s.id === "contract-test-sec-01");
  assert.ok(liveSec, "Public site endpoint must return saved section from colleges.websiteConfig");
  console.log(`✓ GET /api/v1/public/site/${subdomain} correctly returns public website rendering data`);

  console.log("\n==========================================================");
  console.log("   CONTRACT VERIFICATION PASSED WITH 100% EVIDENCE   ");
  console.log("==========================================================");

  await mongoose.disconnect();
  process.exit(0);
}

verifyEditorContract().catch((err) => {
  console.error("Contract verification failed:", err);
  process.exit(1);
});
