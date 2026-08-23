import { randomBytes } from "node:crypto";

/**
 * Neutralises a secret that is not a secret.
 *
 * On 2026-08-20 the production API was found running with
 * `SESSION_SECRET` and `ADMIN_SESSION_SECRET` set to the literal placeholder
 * values from this repository's own `.env.example` — a file that was, at the
 * time, readable by anyone on the internet. Sessions here are HS256 JWTs, so
 * holding the signing key is the whole of authentication: anybody who read that
 * file could mint a valid session for any college, or for a Super Admin, without
 * guessing anything. Every access control in this service was decorative for as
 * long as that was true.
 *
 * Nothing detected it, because nothing was looking. A placeholder is a valid
 * string of sufficient length, so `secretKey()` accepted it, the service booted,
 * the logs were clean and the product worked exactly as designed.
 *
 * That is the gap this closes. A deployment carrying a known key now replaces it
 * at boot with one generated for that process — the published key stops being
 * able to sign anything, and the service keeps serving. See
 * `assertSecretsAreSafe` for why it degrades rather than refusing to start.
 */

/**
 * Values that have appeared in this repository, in its history, or in the
 * documentation people copy from. Compared case-insensitively after trimming
 * quotes, because that is how they get pasted.
 *
 * Add to this list, never remove from it: a key that was ever published is
 * burned permanently, whatever it is later used for.
 */
const KNOWN_PUBLISHED_SECRETS = [
  "super-secret-session-key-for-xite-local-dev-32chars",
  "super-secret-admin-session-key-32chars",
  "replace-with-secure-admin-password",
  "changeme",
  "change-me",
  "secret",
  "password",
  // Found committed in this repository during the 2026-08-23 audit. "2008" was
  // the Super Admin password accepted by `adminLogin` and re-applied on every
  // boot by `bootstrapAdmin`; the other two were account passwords baked into
  // `access-service.ts` and `lib/auth/demo.ts` in xite-F. All three are burned.
  "2008",
  "college123",
  "greenfield123",
  "replace-with-a-random-string-of-at-least-32-characters",
];

/** Placeholders read as instructions rather than values. */
const PLACEHOLDER_MARKERS = [
  "your-",
  "<",
  "example",
  "placeholder",
  "local-dev",
  "replace-with",
];

const MIN_LENGTH = 32;

export type SecretProblem = { name: string; reason: string };

/** Strips the quotes an .env value is often pasted with. */
function normalise(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

/**
 * Checks one secret, returning why it is unacceptable — or null.
 *
 * Exported so it can be tested without setting environment variables.
 */
export function inspectSecret(name: string, rawValue: string | undefined): SecretProblem | null {
  const value = normalise(rawValue ?? "");

  if (!value) return { name, reason: "is not set" };

  if (value.length < MIN_LENGTH) {
    return { name, reason: `is ${value.length} characters; at least ${MIN_LENGTH} are required` };
  }

  const lower = value.toLowerCase();

  if (KNOWN_PUBLISHED_SECRETS.some((known) => lower === known.toLowerCase())) {
    return {
      name,
      reason:
        "is a placeholder published in this repository. Anyone who has read it can forge sessions — generate a new one with `openssl rand -base64 48`",
    };
  }

  if (PLACEHOLDER_MARKERS.some((marker) => lower.includes(marker))) {
    return {
      name,
      reason: "looks like a placeholder rather than a generated secret",
    };
  }

  if (new Set(value).size < 8) {
    return { name, reason: "has too little variety to be a generated secret" };
  }

  return null;
}

/**
 * Checks every secret this service signs with, and makes an untrusted one
 * harmless without taking the service down.
 *
 * This exited the process when it was first written, which is the textbook
 * answer and was the wrong one. It shipped into a deployment whose keys had not
 * yet been rotated, the API and the frontend both refused to boot, and the
 * platform was down until somebody could be walked through generating a pair of
 * secrets. A control that turns a known-bad configuration into an outage gets
 * reverted in a hurry, and then protects nothing.
 *
 * Refusing the *key* is what matters, not refusing to run. An untrusted key is
 * replaced at boot with a generated one held only in this process, so:
 *
 *   - the published key can no longer sign anything this service will accept,
 *     which is the entire security goal;
 *   - the service starts, and every college website stays up;
 *   - sessions do not survive a restart, and the frontend cannot verify a cookie
 *     it did not sign, so the misconfiguration stays visible in the product
 *     rather than being papered over.
 *
 * It is a degraded mode, announced as one. The fix is still to set a real value.
 */
export function assertSecretsAreSafe(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const checks: { name: string; required: boolean }[] = [
    { name: "SESSION_SECRET", required: true },
    // Unset is legitimate: the admin signing key is then generated and stored in
    // the database instead. Only a *bad* value is replaced here.
    { name: "ADMIN_SESSION_SECRET", required: false },
  ];

  const replaced: SecretProblem[] = [];

  for (const { name, required } of checks) {
    const raw = env[name];
    if (!required && raw === undefined) continue;

    const problem = inspectSecret(name, raw);
    if (!problem) continue;

    env[name] = randomBytes(48).toString("base64");
    replaced.push(problem);
  }

  if (replaced.length === 0) return;

  console.error(
    [
      "",
      "  ┌──────────────────────────────────────────────────────────────┐",
      "  │  RUNNING ON TEMPORARY SIGNING KEYS                           │",
      "  └──────────────────────────────────────────────────────────────┘",
      "",
      ...replaced.map(({ name, reason }) => `  ${name} ${reason}`),
      "",
      "  Each has been replaced with a key generated for this process, so",
      "  nothing signed with the old one is accepted. Two consequences:",
      "",
      "    - every session ends when this service restarts;",
      "    - the frontend cannot verify a cookie it does not share a key with,",
      "      so sessions will not renew.",
      "",
      "  Set real values and redeploy:",
      "",
      "      openssl rand -base64 48",
      "",
    ].join("\n"),
  );
}
