import "dotenv/config";
import { prisma } from "../src/db.js";
import { submitAccessRequest, listAccessRequests, approveAccessRequest } from "../src/access-service.js";
import { login } from "../src/auth-service.js";

async function runE2ETest() {
  console.log("=== STARTING FULL E2E AUTHENTICATION & APPROVAL TEST ===");

  const testEmail = `e2e_${Date.now()}@example.com`;
  const testPassword = "MySecretUserPassword123!";
  const testName = "E2E Verification User";
  const testOrg = "E2E Test Institute";

  console.log(`\nStep 1: User submits Access Request (${testEmail})...`);
  const reqRes = await submitAccessRequest({
    name: testName,
    email: testEmail,
    password: testPassword,
    organization: testOrg,
    message: "Automated verification test",
  });
  console.log("Submit Access Request Response:", reqRes);

  console.log("\nStep 2: Admin queries Access Requests (status=ALL)...");
  const requests = await listAccessRequests({ status: "ALL" });
  const pendingReq = requests.find((r) => r.email === testEmail);

  if (!pendingReq) {
    throw new Error(`CRITICAL FAIL: Access request for ${testEmail} was not found in admin list!`);
  }
  console.log("Found Access Request in Admin List:", {
    id: pendingReq.id,
    name: pendingReq.name,
    email: pendingReq.email,
    status: pendingReq.status,
    hasPassword: pendingReq.hasPassword,
  });

  if (!pendingReq.hasPassword) {
    throw new Error("CRITICAL FAIL: hasPassword flag should be true for user who set a password!");
  }

  console.log("\nStep 3: Admin approves the Access Request...");
  let admin = await prisma.adminUser.findFirst();
  if (!admin) {
    admin = await prisma.adminUser.create({
      data: {
        email: "admin@xite.co.in",
        passwordHash: "$2a$12$e2etestadminpasswordhash000000000000000000000000000",
      },
    });
  }
  const adminSession = { adminId: admin.id, email: admin.email };
  const approveRes = await approveAccessRequest(pendingReq.id, adminSession);
  console.log("Approval Result:", {
    email: approveRes.email,
    name: approveRes.name,
    userCreated: approveRes.user.id,
  });

  console.log(`\nStep 4: User logs in on xite-F with their requested password (${testPassword})...`);
  const loginRes = await login({
    email: testEmail,
    password: testPassword,
  });
  console.log("SUCCESS! User Logged In successfully with their requested password!", {
    subdomain: loginRes.subdomain,
    next: loginRes.next,
    tokenMinted: Boolean(loginRes.token),
  });

  // Cleanup test records
  console.log("\nCleaning up test records...");
  await prisma.user.deleteMany({ where: { email: testEmail } });
  await prisma.accessRequest.deleteMany({ where: { email: testEmail } });
  console.log("\n==================================================");
  console.log("🎉 ALL E2E LIFECYCLE STEPS PASSED 100% PERFECTLY!");
  console.log("==================================================");

  await prisma.$disconnect();
}

runE2ETest().catch((err) => {
  console.error("E2E Test Failed:", err);
  process.exit(1);
});
