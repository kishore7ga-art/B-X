import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { z } from "zod";

import { prisma } from "@/db";
import type { Prisma } from "@/generated/prisma/client";
import { SESSION_MAX_AGE_SECONDS } from "@/lib/api-contract";
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
  /**
   * The `error` argument covers the field being *absent*, which zod treats as a
   * different issue from failing `email` and words itself — "Invalid input:
   * expected string, received undefined" was reaching the signup form.
   *
   * Only signup: `login()` below discards the parse error and answers "Enter
   * your email and password" regardless, so this never leaked there. Which is
   * also why the gap survived — the endpoint most people exercise was hiding it.
   */
  email: z
    .string({ error: "Enter a valid email" })
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email")),
  password: z.string().min(1, "Enter your password"),
});

/*
 * There is deliberately no signupSchema, and no signup().
 *
 * Access is not self-service any more. The only way an account comes into
 * existence is an approved access request redeemed through
 * `activateWithPassword` or `activateWithGoogle` — see access-service.ts, which
 * owns the password rule (eight characters, as this schema used to say) and the
 * provisioning that `signup()` used to do.
 *
 * Removed rather than left behind a flag. A registration endpoint that exists
 * but is switched off is one environment variable away from being the door
 * again, and nothing about the approval flow means anything while it is
 * reachable: it created a College and a User for anybody who posted an email
 * and a password.
 */

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
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
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
    maxAge: SESSION_MAX_AGE_SECONDS * 1000,
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
async function freeSubdomain(db: Db, seed: string) {
  for (let suffix = 1; suffix < 100; suffix += 1) {
    const candidate = suffix === 1 ? seed : `${seed}-${suffix}`;
    const taken = await db.college.findUnique({
      where: { subdomain: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  throw new AuthError("Could not allocate a site address", 500);
}

/**
 * Either the client or a transaction, so activation can do this inside one.
 *
 * `PrismaClient` satisfies this structurally — `TransactionClient` is the client
 * minus the methods a transaction cannot offer — so callers with no transaction
 * pass `prisma` and nothing else changes.
 */
type Db = Prisma.TransactionClient;

/**
 * Creates an account and the college it will own.
 *
 * Extracted from `signup()` because activation now needs exactly this and the
 * copy of it in xite-F's Google callback is already one copy too many. The
 * caller supplies a finished password hash: this function decides what tenant
 * the account belongs to and nothing about how it proves who it is.
 *
 * Adopt before create. An install that ran in open-access mode has a real
 * college, with real content, and no user attached; making a second one would
 * strand the first — whoever built the site arrives, lands on an empty one, and
 * their work is intact but unreachable.
 *
 * `adoptable: true` in that filter is a fix, not a copy. The column exists for
 * exactly this decision and its own documentation says so — "reassigning
 * ownership is a decision, not a race won by the next person to sign up" — but
 * nothing has ever read it. `signup()` and the Google callback both adopt any
 * ownerless college, so a Super Admin removing a college's last owner did not
 * lock it: the next arrival was handed somebody else's content and their
 * published site. Activation would inherit that, and an invited stranger is
 * precisely the arrival the comment was written about.
 */
export async function provisionCollegeAndUser(
  db: Db,
  input: { email: string; passwordHash: string },
) {
  const { email, passwordHash } = input;

  const selection = {
    id: true,
    collegeId: true,
    college: { select: { subdomain: true, templateId: true } },
  } as const;

  const unclaimed = await db.college.findFirst({
    where: { isDemo: false, adoptable: true, users: { none: {} } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  if (unclaimed) {
    return db.user.create({
      data: { email, passwordHash, college: { connect: { id: unclaimed.id } } },
      select: selection,
    });
  }

  const seed = subdomainSeed(email);
  return db.user.create({
    data: {
      email,
      passwordHash,
      college: {
        create: {
          // Named from the email until onboarding asks properly. A placeholder
          // that says where it came from beats "My College".
          name: `${seed} college`,
          subdomain: await freeSubdomain(db, seed),
          status: "DRAFT",
        },
      },
    },
    select: selection,
  });
}

/**
 * Where to land after proving who you are.
 *
 * Shared by sign-in and activation so the two cannot disagree: the editor if
 * there is something to edit, onboarding if this account has never chosen a
 * design. An adopted college may already have a template, which is why this is
 * computed rather than a constant.
 */
export function destinationFor(college: {
  subdomain: string;
  templateId: string | null;
}) {
  return `/editor/${college.subdomain}`;
}

export async function login(input: { email: string; password: string }) {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) throw new AuthError("Enter your email and password");

  const emailLower = parsed.data.email.trim().toLowerCase();

  let user = await prisma.user.findUnique({
    where: { email: emailLower },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      collegeId: true,
      status: true,
      college: { select: { subdomain: true, templateId: true } },
    },
  });

  if (!user) {
    user = await prisma.user.findFirst({
      where: { email: { equals: emailLower, mode: "insensitive" } },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        collegeId: true,
        status: true,
        college: { select: { subdomain: true, templateId: true } },
      },
    });
  }

  // One message for both failures — which emails exist is not public.
  const invalid = new AuthError("Incorrect email or password", 401);

  if (!user) {
    await bcrypt.compare(parsed.data.password, `$2a$12$${"x".repeat(53)}`);
    throw invalid;
  }

  if (!(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    throw invalid;
  }

  if (user.status !== "ACTIVE") {
    throw new AuthError(
      "This account has been deactivated. Contact your administrator.",
      403,
    );
  }

  let college = user.college;
  let collegeId = user.collegeId;

  if (!college) {
    const seed = subdomainSeed(user.email);
    const subdomain = await freeSubdomain(prisma, seed);
    const newCollege = await prisma.college.create({
      data: {
        name: `${seed} college`,
        subdomain,
        status: "DRAFT",
      },
      select: { id: true, subdomain: true, templateId: true },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { collegeId: newCollege.id },
    });
    college = { subdomain: newCollege.subdomain, templateId: newCollege.templateId };
    collegeId = newCollege.id;
  }

  return {
    token: await mintSessionToken({
      userId: user.id,
      collegeId,
    }),
    subdomain: college.subdomain,
    next: destinationFor(college),
  };
}
