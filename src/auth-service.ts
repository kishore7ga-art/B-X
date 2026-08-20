import bcrypt from "bcryptjs";
import { SignJWT } from "jose";
import { z } from "zod";
import mongoose from "mongoose";

import { AccessRequest, College } from "@/models";
import { SESSION_MAX_AGE_SECONDS } from "@/lib/api-contract";
import {
  hostFromOrigin,
  sessionCookieScope,
  type CookieScope,
} from "@/lib/auth/cookie-domain";

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
  email: z
    .string({ error: "Enter a valid email" })
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email")),
  password: z.string().min(1, "Enter your password"),
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
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(secretKey());
}

function frontendOrigin(): string | undefined {
  return (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .find(Boolean);
}

let announcedScope = false;

function announce(scope: CookieScope) {
  if (announcedScope) return;
  announcedScope = true;

  if (scope.source !== "host-only") {
    console.log(
      `[auth] session cookie scoped to ${scope.domain} (${scope.source})`,
    );
    return;
  }

  const log = scope.reason.includes("SESSION_COOKIE_DOMAIN")
    ? console.warn
    : console.log;
  log(`[auth] session cookie is host-only — ${scope.reason}`);
}

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
    sameSite: (crossSite ? "none" : "lax") as "none" | "lax",
    secure: crossSite || process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS * 1000,
    ...(domain ? { domain } : {}),
  };
}

function subdomainSeed(email: string) {
  const base = email
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return base.length >= 3 ? base : "site";
}

async function freeSubdomain(seed: string) {
  for (let suffix = 1; suffix < 100; suffix += 1) {
    const candidate = suffix === 1 ? seed : `${seed}-${suffix}`;
    const taken = await College.findOne({ subdomain: candidate }).select("_id");
    if (!taken) return candidate;
  }
  throw new AuthError("Could not allocate a site address", 500);
}

export async function provisionCollegeAndUser(
  _db: any,
  input: { email: string; passwordHash: string },
) {
  const { email, passwordHash } = input;
  const emailLower = email.toLowerCase().trim();
  const userId = new mongoose.Types.ObjectId().toString();

  const unclaimed = await College.findOne({
    isDemo: false,
    adoptable: true,
    $or: [{ users: { $exists: false } }, { users: { $size: 0 } }],
  }).sort({ createdAt: 1 });

  if (unclaimed) {
    unclaimed.users.push({
      id: userId,
      email: emailLower,
      passwordHash,
      status: "ACTIVE",
      createdAt: new Date(),
    });
    await unclaimed.save();
    return {
      id: userId,
      collegeId: unclaimed.id,
      college: { subdomain: unclaimed.subdomain, templateId: unclaimed.templateId },
    };
  }

  const seed = subdomainSeed(emailLower);
  const subdomain = await freeSubdomain(seed);

  const newCollege = await College.create({
    name: `${seed} college`,
    subdomain,
    status: "DRAFT",
    users: [
      {
        id: userId,
        email: emailLower,
        passwordHash,
        status: "ACTIVE",
        createdAt: new Date(),
      },
    ],
  });

  return {
    id: userId,
    collegeId: newCollege.id,
    college: { subdomain: newCollege.subdomain, templateId: newCollege.templateId },
  };
}

export function destinationFor(college: {
  subdomain: string;
  templateId?: string | null;
}) {
  return `/editor/${college.subdomain}`;
}

export async function login(input: { email: string; password: string }) {
  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) throw new AuthError("Enter your email and password");

  const emailLower = parsed.data.email.trim().toLowerCase();

  const college = await College.findOne({ "users.email": emailLower });
  const user = college?.users.find((u: any) => u.email.toLowerCase() === emailLower);

  const invalid = new AuthError("Incorrect email or password", 401);

  if (!college || !user) {
    // Constant-ish time regardless of whether the address is known.
    await bcrypt.compare(parsed.data.password, `$2a$12$${"x".repeat(53)}`);

    /**
     * "Incorrect email or password" is a lie to most of the people who see it.
     *
     * Registration does not create an account. It writes an AccessRequest, with
     * the password the person chose hashed onto *that* document, and a Super
     * Admin has to approve it before `college.users[]` gains an entry. Until
     * then the credentials exist in the database — they are simply not anywhere
     * `login()` looks.
     *
     * At the time of writing that is 227 people, each of whom picked a password,
     * was told their request was submitted, and has been told ever since that
     * they typed it wrong. They retry, they reset, they give up. The single most
     * common "login is broken" report is this message.
     *
     * It does disclose whether an address has a pending request, which the
     * generic message does not. That trade is worth making here: this is an
     * approval queue people are waiting in, the fact that they applied is
     * already known to them, and the alternative is a product that tells its
     * users nothing true.
     */
    const pending = await AccessRequest.findOne({ applicantEmail: emailLower }).sort({
      createdAt: -1,
    });

    if (pending?.status === "PENDING") {
      throw new AuthError(
        "Your access request is still awaiting approval. You will be able to sign in once an administrator approves it.",
        403,
      );
    }

    if (pending?.status === "REJECTED") {
      throw new AuthError(
        "Your access request was not approved. Contact your administrator if you believe this is a mistake.",
        403,
      );
    }

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

  return {
    token: await mintSessionToken({
      userId: user.id,
      collegeId: college.id,
    }),
    user: { id: user.id, email: user.email },
    collegeId: college.id,
    subdomain: college.subdomain,
    next: destinationFor(college),
  };
}
