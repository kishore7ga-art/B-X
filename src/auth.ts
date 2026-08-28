import { jwtVerify } from "jose";

import { College } from "@/models";

const COOKIE_NAME = "college_session";

export type Session = { userId: string; collegeId: string };

function secretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be set and at least 32 characters");
  }
  return new TextEncoder().encode(secret);
}

/*
 * There was a module-level `AUTH_DISABLED` here, and it was both dead and
 * dangerous:
 *
 *     const AUTH_DISABLED = process.env.AUTH_DISABLED !== "false";
 *
 * Nothing read it — `getSession` below tests the environment variable directly,
 * and correctly, with `=== "true"`. But the two spellings are opposites at the
 * default: with the variable unset, this constant was `true` and the check
 * below is `false`. Anything that had started using it would have switched
 * open-access on for every deployment that had simply not set the variable,
 * which is most of them.
 *
 * Removed rather than corrected. The frontend mirrors this decision in
 * `lib/auth/open-access.ts` and the two services must agree on who the caller
 * is — a second copy of the rule in this file is how they stop agreeing.
 */

async function openAccessCollege() {
  const existing = await College.findOne({ isDemo: false }).sort({ createdAt: 1 });
  if (existing) return existing;

  const subdomain = process.env.OPEN_ACCESS_SUBDOMAIN || "greenfield";
  const name = process.env.OPEN_ACCESS_COLLEGE_NAME || "Greenfield University";

  const upserted = await College.findOneAndUpdate(
    { subdomain },
    { $setOnInsert: { name, subdomain, status: "DRAFT" } },
    { upsert: true, new: true }
  );

  return upserted;
}

/** Parses the session cookie off a raw Cookie header. */
function readCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

export async function getSession(
  cookieHeader: string | undefined,
): Promise<Session | null> {
  const sessionData = await readSession(cookieHeader);
  if (sessionData) return sessionData.session;

  if (process.env.AUTH_DISABLED === "true") {
    const college = await openAccessCollege();
    return { userId: `open-access:${college.id}`, collegeId: college.id };
  }

  return null;
}

/**
 * The session plus when it was issued, for deciding whether to renew it.
 *
 * Separate from `getSession` because renewal must not see through open-access
 * mode: that branch invents a session from no token at all, and there is
 * nothing there to re-issue.
 */
export async function readSession(
  cookieHeader: string | undefined,
): Promise<{ session: Session; issuedAt: number } | null> {
  const token = readCookie(cookieHeader, COOKIE_NAME);
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secretKey());
    const { userId, collegeId, iat } = payload as Record<string, unknown>;
    if (typeof userId !== "string" || typeof collegeId !== "string") return null;
    return {
      session: { userId, collegeId },
      // A token minted without `iat` cannot be aged, so treat it as due —
      // re-issuing one is harmless and gets it a timestamp.
      issuedAt: typeof iat === "number" ? iat : 0,
    };
  } catch {
    // Expired or tampered — signed out, not an error worth surfacing.
    return null;
  }
}
