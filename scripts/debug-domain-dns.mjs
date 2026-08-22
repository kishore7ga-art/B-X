import dns from "node:dns/promises";

async function debugDnsAndRouting() {
  console.log("========================================================================");
  console.log("  DNS & DIRECT PRODUCTION CONTAINER ROUTING DIAGNOSTIC                   ");
  console.log("========================================================================");

  try {
    const addresses = await dns.resolve4("api.webxite.org").catch(() => []);
    console.log("Resolved IPv4 Addresses for api.webxite.org:", addresses);

    const cb = Date.now();
    const r1 = await fetch(`https://api.webxite.org/api/health?cb=${cb}`, {
      headers: { "Cache-Control": "no-cache, no-store", "Pragma": "no-cache" }
    });
    console.log(`GET https://api.webxite.org/api/health?cb=${cb} → Status: ${r1.status}`);
    const b1 = await r1.text();
    console.log("Body:", b1.substring(0, 300));

    const r2 = await fetch(`https://api.webxite.org/health?cb=${cb}`, {
      headers: { "Cache-Control": "no-cache, no-store", "Pragma": "no-cache" }
    });
    console.log(`GET https://api.webxite.org/health?cb=${cb} → Status: ${r2.status}`);
    const b2 = await r2.text();
    console.log("Body:", b2.substring(0, 300));

  } catch (err) {
    console.error("Diagnostic error:", err);
  }
}

debugDnsAndRouting();
