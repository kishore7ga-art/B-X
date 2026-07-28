import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { z } from "zod";

import { prisma } from "@/db";
import {
  hostFromOrigin,
  sessionCookieScope,
  type CookieScope,
} from "@/lib/auth/cookie-domain";

/**
 * Account creation and sign-in, owned by the backend.
 *
 * These used to be Next.js Server Actions in the frontend, which meant sign-in
 * POSTed to `xite.co.in/login` as an RSC payload — invisible in the Network tab
 * as an API call, and impossible to point at this service. Moving them here is
 * what makes "all API calls go to the backend" true of authentication too.
 */

const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export const COOKIE_NAME = "college_session";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email")),
  password: z.string().min(1, "Enter your password"),
});

export const signupSchema = credentialsSchema.extend({
  password: z.string().min(8, "Password must be at least 8 characters"),
});

function secretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be set and at least 32 characters");
  }
  return new TextEncoder().encode(secret);
}

export async function mintSessionToken(payload: {
  userId: string;
  collegeId: string;
}): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

/** The frontend this API serves, as named in CORS_ORIGINS. */
function frontendOrigin(): string | undefined {
  return (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .find(Boolean);
}

/**
 * Said once, at the first cookie written, rather than per request.
 *
 * A host-only cookie in a split deployment is the failure that reports itself
 * as success, so the resolved scope is worth a line in the log either way —
 * previously it was answerable only by capturing a Set-Cookie header off a
 * live response.
 */
let announcedScope = false;

function announce(scope: CookieScope) {
  if (announcedScope) return;
  announcedScope = true;

  // Discriminated on `source`, not on `domain` being truthy: the latter reads
  // more naturally and does not narrow the union, so `reason` stays invisible.
  if (scope.source !== "host-only") {
    console.log(
      `[auth] session cookie scoped to ${scope.domain} (${scope.source})`,
    );
    return;
  }

  // Single-service and local setups land here legitimately, so this is only a
  // warning when the two hosts genuinely cannot share one cookie.
  const log = scope.reason.includes("SESSION_COOKIE_DOMAIN")
    ? console.warn
    : console.log;
  log(`[auth] session cookie is host-only — ${scope.reason}`);
}

/**
 * Cookie attributes for a session issued by api.xite.co.in and read by
 * xite.co.in.
 *
 * `Domain` is the whole reason this works. Without it the cookie is scoped to
 * api.xite.co.in alone, and the frontend — which renders every guarded page
 * server-side — would never see it: sign-in appears to succeed and every page
 * after it says signed out.
 *
 * That is a bad thing to rest on someone remembering an environment variable,
 * because forgetting it breaks authentication and logs nothing at all. It is
 * derived from the two hostnames instead — this request's own, and the
 * frontend's from CORS_ORIGINS, which the browser already requires to be
 * correct before it will make the call. `SESSION_COOKIE_DOMAIN` still overrides
 * for a topology this cannot infer, and local development gets a host-only
 * cookie because localhost cannot carry a Domain.
 */
export function cookieOptions(apiHost?: string) {
  const scope = sessionCookieScope({
    configured: process.env.SESSION_COOKIE_DOMAIN,
    frontendHost: hostFromOrigin(frontendOrigin()),
    apiHost: hostFromOrigin(apiHost),
  });
  announce(scope);

  const domain = scope.domain;
  const crossSite = Boolean(domain);

  return {
    httpOnly: true,
    // `none` is required to send this on a cross-origin fetch from the
    // frontend, and browsers only accept `none` alongside `secure`.
    sameSite: (crossSite ? "none" : "lax") as "none" | "lax",
    secure: crossSite || process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS * 1000,
    ...(domain ? { domain } : {}),
  };
}

/** `someone@college.edu` → `someone`, with anything unusable stripped. */
function subdomainSeed(email: string) {
  const base = email
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return base.length >= 3 ? base : "site";
}

/** First free variant of `seed`, `seed-2`, `seed-3`… */
async function freeSubdomain(seed: string) {
  for (let suffix = 1; suffix < 100; suffix += 1) {
    const candidate = suffix === 1 ? seed : `${seed}-${suffix}`;
    const taken = await prisma.college.findUnique({
      where: { subdomain: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  throw new AuthError("Could not allocate a site address", 500);
}

/**
 * Creates an account from an email and password alone.
 *
 * Deliberately no session: the flow is signup → sign in → editor, so proving
 * the password works is part of creating the account rather than something
 * discovered a week later.
 */
export async function signup(input: { email: string; password: string }) {
  const { email, password } = signupSchema.parse(input);

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) throw new AuthError("That email is already registered", 409);

  const passwordHash = await bcrypt.hash(password, 12);

  /**
   * Adopt an unclaimed college before creating one.
   *
   * An install that ran in open-access mode has a real college, with real
   * content, and no user attached. Creating a second one would strand the
   * first: whoever built the site signs up, lands on an empty one, and their
   * work is intact but unreachable.
   */
  const unclaimed = await prisma.college.findFirst({
    where: { isDemo: false, users: { none: {} } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  const user = unclaimed
    ? await prisma.user.create({
        data: { email, passwordHash, college: { connect: { id: unclaimed.id } } },
        select: { id: true },
      })
    : await prisma.user.create({
        data: {
          email,
          passwordHash,
          college: {
            create: {
              // Named from the email until onboarding asks properly. A
              // placeholder that says where it came from beats "My College".
              name: `${subdomainSeed(email)} college`,
              subdomain: await freeSubdomain(subdomainSeed(email)),
              status: "DRAFT",
            },
          },
        },
        select: { id: true },
      });

  return { id: user.id, email };
}

export async function login(input: { email: string; password: string }) {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) throw new AuthError("Enter your email and password");

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
    select: {
      id: true,
      passwordHash: true,
      collegeId: true,
      college: { select: { subdomain: true, templateId: true } },
    },
  });

  // One message for both failures — which emails exist is not public.
  const invalid = new AuthError("Incorrect email or password", 401);

  if (!user) {
    // Comparable work for a missing user, so absence isn't obvious from timing.
    await bcrypt.compare(parsed.data.password, `$2a$12$${"x".repeat(53)}`);
    throw invalid;
  }

  if (!(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    throw invalid;
  }

  return {
    token: await mintSessionToken({
      userId: user.id,
      collegeId: user.collegeId,
    }),
    subdomain: user.college.subdomain,
    // Where to land: the editor if there is something to edit, onboarding if
    // this account has never chosen a design.
    next: user.college.templateId
      ? `/editor/${user.college.subdomain}`
      : "/onboarding",
  };
}
