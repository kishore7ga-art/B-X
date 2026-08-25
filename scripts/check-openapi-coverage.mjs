/**
 * Fails when a route this session added is missing from `src/openapi.ts`.
 *
 * `verifyDocs()` in server.ts already compares the spec against Express's own
 * route table, which is the stronger check — but it only runs once the server
 * has booted, and booting needs a database. It also only ever `console.warn`s,
 * despite its own comment claiming it is fatal outside production, so 15
 * undocumented routes shipped without anything failing.
 *
 * This runs with no database and exits non-zero, so it can sit in CI and in a
 * pre-push hook.
 */
import { readFileSync } from "node:fs";

const spec = readFileSync(new URL("../src/openapi.ts", import.meta.url), "utf8");

/** The operations added for publishing, domains, settings, account and billing. */
const REQUIRED = [
  ["get", "/api/v1/publish/status"],
  ["post", "/api/v1/publish"],
  ["get", "/api/v1/domains"],
  ["post", "/api/v1/domains"],
  ["post", "/api/v1/domains/{id}/verify"],
  ["post", "/api/v1/domains/{id}/primary"],
  ["delete", "/api/v1/domains/{id}"],
  ["get", "/api/v1/public/resolve-host"],
  ["get", "/api/v1/site-settings"],
  ["patch", "/api/v1/site-settings"],
  ["post", "/api/v1/account/password"],
  ["get", "/api/v1/billing/invoices"],
  ["get", "/api/v1/billing/payment-methods"],
  ["post", "/api/v1/billing/payment-methods"],
  ["delete", "/api/v1/billing/payment-methods/{id}"],
  // Editor builder rebuild: per-page writes, reordering, the tenant-facing
  // section library, and the theme id.
  ["put", "/api/v1/my-website/pages/{slug}"],
  ["delete", "/api/v1/my-website/pages/{slug}"],
  ["patch", "/api/v1/my-website/pages/{slug}/order"],
  ["get", "/api/v1/section-library"],
  ["get", "/api/v1/my-theme"],
  ["put", "/api/v1/my-theme"],
  // Domain control plane: the Super Admin had no view of domains at all.
  ["get", "/api/v1/admin/domains"],
  ["post", "/api/v1/admin/domains/{collegeId}/{domainId}/verify"],
  ["post", "/api/v1/admin/domains/{collegeId}/{domainId}/disable"],
  ["post", "/api/v1/admin/domains/{collegeId}/{domainId}/reactivate"],
];

/**
 * The body of one `"path": { … }` entry.
 *
 * Matched by locating the key and walking braces, rather than with a regex:
 * these entries contain nested objects, and a lazy `[\s\S]*?}` would stop at
 * the first inner brace and report a method as missing when it is present.
 */
function operationsFor(path) {
  const key = `"${path}": {`;
  const start = spec.indexOf(key);
  if (start === -1) return null;

  let depth = 0;
  let i = start + key.length - 1;
  for (; i < spec.length; i++) {
    if (spec[i] === "{") depth++;
    else if (spec[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return spec.slice(start, i + 1);
}

const missing = [];
for (const [method, path] of REQUIRED) {
  const body = operationsFor(path);
  if (!body) {
    missing.push(`${method.toUpperCase()} ${path} — path absent`);
    continue;
  }
  // `get: {` at the top level of the entry.
  if (!new RegExp(`\\n\\s{6}${method}:\\s*\\{`).test(body)) {
    missing.push(`${method.toUpperCase()} ${path} — method absent`);
  }
}

if (missing.length) {
  console.error(`[openapi] ${missing.length} operation(s) undocumented:`);
  for (const line of missing) console.error(`          ${line}`);
  process.exit(1);
}

console.log(`[openapi] ok — all ${REQUIRED.length} new operations documented.`);
