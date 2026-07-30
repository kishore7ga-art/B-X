import { createRemoteJWKSet, jwtVerify } from "jose";

import { AuthError } from "@/auth-service";

/**
 * Verifying a Google identity token, here rather than trusting the frontend.
 *
 * This exists because of one line in the guide this flow came from: the Google
 * account's address must match the address the invite was issued to. That is not
 * a nicety — it is the entire security boundary of activation-by-Google. An
 * invite is a bearer token in an email, and without the match anyone who
 * intercepts one can redeem it with their own Google account and end up owning
 * the college it was meant for.
 *
 * So the comparison has to happen where the invite lives, and it has to compare
 * against an address this service established for itself. xite-F already runs the
 * code exchange and could simply tell us the email — but an endpoint that
 * believes a caller-supplied address is exactly the hole the match is supposed to
 * close, and "the caller is our own frontend" is an assumption, not a check. The
 * raw id_token is forwarded instead and verified again here, against Google's
 * keys.
 *
 * Deliberately duplicates the verification half of `xite-F/src/lib/auth/google.ts`
 * and not the exchange half: this service has no client secret and never talks to
 * Google's token endpoint. When batch 6 of the API boundary moves Google sign-in
 * here, that file collapses into this one.
 */
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/** Fetched once and cached; Google rotates these keys. */
const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

/**
 * The client id, which is public — it is in every authorization URL a browser
 * follows. No secret is needed to verify a signature, only to obtain the token,
 * and obtaining it is the frontend's job.
 */
const clientId = () => process.env.GOOGLE_CLIENT_ID?.trim();

export function googleVerifyConfigured(): boolean {
  return Boolean(clientId());
}

export type GoogleIdentity = { email: string; name: string | null };

/**
 * Reads a Google identity out of an id_token, or refuses.
 *
 * `audience` is the check that matters most after the signature: a token signed
 * by Google for *somebody else's* application is still a valid Google token, and
 * without pinning the audience this would accept one. That is how a token issued
 * to an unrelated app becomes a login here.
 */
export async function verifyGoogleIdToken(
  idToken: string,
): Promise<GoogleIdentity> {
  const audience = clientId();
  if (!audience) {
    throw new AuthError(
      "Google sign-in is not configured on this deployment",
      503,
    );
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, JWKS, {
      issuer: ISSUERS,
      audience,
    }));
  } catch (cause) {
    // Expired, wrong audience, bad signature, unreachable JWKS — all the same
    // answer to the caller, and the reason is ours to read in the log.
    console.error(
      `[google] id_token rejected: ${cause instanceof Error ? cause.message : cause}`,
    );
    throw new AuthError("Could not verify that Google account", 401);
  }

  const email = typeof payload.email === "string" ? payload.email : null;
  if (!email) throw new AuthError("Could not verify that Google account", 401);

  /**
   * An unverified address is not proof of anything.
   *
   * Google sets this false for some Workspace configurations, and it is the
   * difference between "this person controls this mailbox" and "this person typed
   * this into a profile". The invite was sent to a mailbox.
   */
  if (payload.email_verified !== true) {
    throw new AuthError(
      "That Google account has an unverified email address",
      403,
    );
  }

  return {
    // Lowercased to match how `access_requests.email` is stored, so the
    // comparison downstream is not a coin toss on case.
    email: email.toLowerCase(),
    name: typeof payload.name === "string" ? payload.name : null,
  };
}
