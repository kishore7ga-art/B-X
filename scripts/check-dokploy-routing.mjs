import dns from "node:dns";

try {
  dns.setDefaultResultOrder("ipv4first");
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (e) {}

const API_BASE = "https://api.meetkishore.in";

async function auditDokployRouting() {
  console.log("========================================================================");
  console.log("  DOKPLOY PRODUCTION DOMAIN ROUTING AUDIT & VERIFICATION                ");
  console.log("========================================================================");
  console.log(`Target Domain: ${API_BASE}`);

  try {
    const rHealth = await fetch(`${API_BASE}/api/health`).catch(() => null);
    console.log(`GET ${API_BASE}/api/health → Status: ${rHealth?.status ?? "FETCH_ERROR"}`);
    if (rHealth) {
      const bodyText = await rHealth.text();
      console.log(`Response Body:`, bodyText.substring(0, 300));
    }

    const rLogin = await fetch(`${API_BASE}/api/v1/admin/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@xite.co.in", password: "2008" }),
    }).catch(() => null);

    console.log(`POST ${API_BASE}/api/v1/admin/auth/login → Status: ${rLogin?.status ?? "FETCH_ERROR"}`);
    if (rLogin) {
      console.log(`Set-Cookie Header:`, rLogin.headers.get("set-cookie"));
      const loginBody = await rLogin.text();
      console.log(`Response Body:`, loginBody.substring(0, 300));

      const cookie = rLogin.headers.get("set-cookie");
      if (rLogin.status === 200 && cookie) {
        const rStats = await fetch(`${API_BASE}/api/v1/admin/templates/stats`, {
          headers: { Cookie: cookie },
        });
        console.log(`GET ${API_BASE}/api/v1/admin/templates/stats → Status: ${rStats.status}`);
        console.log(`Stats Body:`, await rStats.text());
      }
    }
  } catch (err) {
    console.error("Audit Error:", err);
  }
}

auditDokployRouting();
