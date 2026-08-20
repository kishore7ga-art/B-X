/**
 * Refuses to start on a secret that is not a secret.
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
 * That is the gap this closes. A deployment carrying a known key now fails
 * loudly at boot rather than serving traffic it cannot protect — the failure is
 * unmissable, it happens before the first request, and it happens in the
 * terminal of whoever deployed it.
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
 * Checks every secret this service signs with, and stops the process if any of
 * them cannot be trusted.
 *
 * Fatal in every environment, deliberately. The temptation is to warn in
 * development and fail in production, and that is precisely how a placeholder
 * reaches production: it works on the machine where it was introduced, so
 * nobody finds out until the environment that matters is already carrying it.
 */
export function assertSecretsAreSafe(
  env: NodeJS.ProcessEnv = process.env,
  exit: (code: number) => never = process.exit as (code: number) => never,
): void {
  const problems = [
    inspectSecret("SESSION_SECRET", env.SESSION_SECRET),
    // Optional: unset means the admin signing key is generated and stored in the
    // database instead. A *bad* value is still fatal — falling back on it would
    // be the same silence this file exists to end.
    env.ADMIN_SESSION_SECRET === undefined
      ? null
      : inspectSecret("ADMIN_SESSION_SECRET", env.ADMIN_SESSION_SECRET),
  ].filter((problem): problem is SecretProblem => problem !== null);

  if (problems.length === 0) return;

  console.error("\n[secrets] Refusing to start.\n");
  for (const { name, reason } of problems) {
    console.error(`  ${name} ${reason}`);
  }
  console.error(
    "\n  Sessions are signed with these keys, so an untrusted key means anyone" +
      "\n  can issue themselves one. Generate replacements with:" +
      "\n" +
      "\n      openssl rand -base64 48" +
      "\n" +
      "\n  then set them in this deployment's environment and restart. Rotating" +
      "\n  invalidates every existing session, which is the intended effect.\n",
  );

  exit(1);
}
