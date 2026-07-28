import bcrypt from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import * as OTPAuth from "otpauth";
import { z } from "zod";

import { prisma } from "@/db";
import { AuthError } from "@/auth-service";

/**
 * Super Admin authentication — deliberately nothing to do with college sign-in.
 *
 * A different table, a different cookie and a different signing key. Not
 * belt-and-braces: a role column on `users` means one bug in one query is the
 * difference between a college owner and somebody who can delete every college,
 * and a shared secret means a forged college token is a forged admin token. As
 * it stands there is no code path from one to the other to get wrong.
 *
 * Two factors, enrolled progressively. An account without a TOTP secret signs
 * in on a password alone; the moment one is enrolled, a code is required and
 * there is no way back to password-only except deliberately clearing it. That
 * is what lets this ship today without leaving second-factor support as a
 * column nobody ever wires up.
 */

export const ADMIN_COOKIE_NAME = "xite_admin_session";

/** Eight hours. An admin session is a shift, not a fortnight. */
const ADMIN_MAX_AGE_SECONDS = 60 * 60 * 8;

export const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email")),
  password: z.string().min(1, "Enter your password"),
  /** Six digits, and only checked when the account has enrolled. */
  token: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code").optional(),
});

/**
 * Fails loudly rather than falling back to the app's own secret.
 *
 * Reusing SESSION_SECRET would work and would quietly undo the separation
 * above. Missing configuration should stop the admin surface, not silently
 * weaken it — this project has already lost a day to an environment variable
 * that failed without saying so.
 */
function adminSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new AuthError(
      "Admin panel is not configured on this deployment",
      503,
    );
  }
  if (secret === process.env.SESSION_SECRET) {
    throw new AuthError(
      "ADMIN_SESSION_SECRET must differ from SESSION_SECRET",
      503,
    );
  }
  return new TextEncoder().encode(secret);
}

/** Whether the admin surface can serve at all, for the health check. */
export function adminConfigured(): boolean {
  const secret = process.env.ADMIN_SESSION_SECRET;
  return Boolean(
    secret && secret.length >= 32 && secret !== process.env.SESSION_SECRET,
  );
}

export type AdminSession = { adminId: string; email: string };

/**
 * Whether the panel has been set up, for the login screen to read.
 *
 * Unauthenticated, deliberately. It says two things — is a signing key
 * configured, and does any account exist — and neither is worth protecting:
 * when the answer is "no accounts", there is nothing to attack, and once one
 * exists this stops saying anything an attacker could use. What it buys is the
 * difference between somebody staring at "Incorrect email, password or code"
 * and somebody being told the account was never created.
 *
 * Deliberately not a count, and never an email. Whether setup is finished is
 * useful; who the admins are is not.
 */
export async function adminStatus() {
  if (!adminConfigured()) {
    return { configured: false as const, hasAccounts: false };
  }
  try {
    return {
      configured: true as const,
      hasAccounts: (await prisma.adminUser.count()) > 0,
    };
  } catch {
    // The table is missing or the database is unreachable — either way setup
    // is not finished, which is what the caller is asking.
    return { configured: true as const, hasAccounts: false };
  }
}

async function mintAdminToken(payload: AdminSession) {
  return new SignJWT({ ...payload, kind: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_MAX_AGE_SECONDS}s`)
    .sign(adminSecret());
}

/**
 * Cookie attributes for the admin session.
 *
 * Host-only on purpose, and the one place this service deliberately differs
 * from the college cookie: that one is scoped to the parent domain so both
 * services can read it. This one has no reason to travel anywhere except back
 * to the panel, so it does not.
 */
export function adminCookieOptions() {
  const crossSite = Boolean(process.env.SESSION_COOKIE_DOMAIN);
  return {
    httpOnly: true,
    sameSite: (crossSite ? "none" : "lax") as "none" | "lax",
    secure: crossSite || process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_MAX_AGE_SECONDS * 1000,
    ...(process.env.SESSION_COOKIE_DOMAIN
      ? { domain: process.env.SESSION_COOKIE_DOMAIN }
      : {}),
  };
}

/** Reads an admin session out of a raw Cookie header. */
export async function getAdminSession(
  cookieHeader: string | undefined,
): Promise<AdminSession | null> {
  if (!adminConfigured()) return null;
  if (!cookieHeader) return null;

  let token: string | undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === ADMIN_COOKIE_NAME) token = rest.join("=");
  }
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, adminSecret());
    // A college token signed with a different key could never verify here, but
    // the claim is checked anyway: it costs nothing and it documents that this
    // verifier accepts exactly one kind of token.
    if (payload.kind !== "admin") return null;
    const { adminId, email } = payload;
    if (typeof adminId !== "string" || typeof email !== "string") return null;
    return { adminId, email };
  } catch {
    return null;
  }
}

/**
 * Signs an admin in.
 *
 * One message for every failure — wrong address, wrong password, missing or
 * wrong code. Which admin accounts exist is not something a login form should
 * be willing to discuss.
 */
export async function adminLogin(input: unknown) {
  const parsed = adminLoginSchema.safeParse(input);
  if (!parsed.success) {
    throw new AuthError(parsed.error.issues[0]?.message ?? "Check your details");
  }

  const { email, password, token } = parsed.data;
  const invalid = new AuthError("Incorrect email, password or code", 401);

  const admin = await prisma.adminUser.findUnique({ where: { email } });

  if (!admin) {
    // Comparable work for a missing account, so absence is not obvious from
    // how quickly this answers.
    await bcrypt.compare(password, `$2a$12$${"x".repeat(53)}`);
    throw invalid;
  }

  if (!(await bcrypt.compare(password, admin.passwordHash))) throw invalid;

  if (admin.totpSecret) {
    if (!token) {
      // Distinguishable on purpose: the password was right, and the form needs
      // to know to ask for the second factor rather than claim it was wrong.
      throw new AuthError("A 6-digit code is required", 401);
    }
    const totp = new OTPAuth.TOTP({
      issuer: "XITE",
      label: admin.email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(admin.totpSecret),
    });
    // One step either side, for clocks that disagree by a few seconds.
    if (totp.validate({ token, window: 1 }) === null) throw invalid;
  }

  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { lastLoginAt: new Date() },
  });

  return {
    token: await mintAdminToken({ adminId: admin.id, email: admin.email }),
    admin: {
      id: admin.id,
      email: admin.email,
      totpEnrolled: Boolean(admin.totpSecret),
    },
  };
}

/**
 * Records what an admin did.
 *
 * Never throws. A failure to write the log must not roll back the action it
 * describes — an unlogged deletion is bad, a deletion that half-happened
 * because logging failed is worse.
 */
export async function recordAudit(entry: {
  actor: AdminSession;
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: entry.actor.adminId,
        actorEmail: entry.actor.email,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        summary: entry.summary,
        metadata: (entry.metadata ?? undefined) as never,
      },
    });
  } catch (error) {
    console.error("[admin] audit write failed:", (error as Error).message);
  }
}

/** The dashboard's numbers, in one round trip. */
export async function adminOverview() {
  const [
    collegesTotal,
    published,
    withoutTemplate,
    templates,
    users,
    recent,
  ] = await Promise.all([
    prisma.college.count({ where: { isDemo: false } }),
    prisma.college.count({ where: { isDemo: false, status: "PUBLISHED" } }),
    prisma.college.count({ where: { isDemo: false, templateId: null } }),
    prisma.template.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        archivedAt: true,
        _count: { select: { colleges: true } },
      },
    }),
    prisma.user.count(),
    prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: {
        id: true,
        actorEmail: true,
        action: true,
        summary: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    colleges: {
      total: collegesTotal,
      published,
      // Not "drafts": a college with no template has not finished onboarding,
      // which is a different problem from one that is written but unpublished.
      onboardingIncomplete: withoutTemplate,
    },
    users,
    templates: templates.map(({ _count, archivedAt, ...template }) => ({
      ...template,
      colleges: _count.colleges,
      archived: Boolean(archivedAt),
    })),
    recentActions: recent.map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

/** Every real college, with a link that actually opens its site. */
export async function adminSites() {
  const colleges = await prisma.college.findMany({
    where: { isDemo: false },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      subdomain: true,
      status: true,
      adoptable: true,
      createdAt: true,
      template: { select: { name: true } },
      _count: { select: { users: true, sections: true } },
      /**
       * Last edited, standing in for "last published", which nothing records.
       *
       * `colleges` has no publishedAt column — status flips to PUBLISHED and
       * the moment it happened is not kept. The newest section save is the
       * closest true answer available, and it is labelled as what it is rather
       * than presented as a publish date it is not.
       */
      sections: {
        select: { lastSavedAt: true },
        orderBy: { lastSavedAt: "desc" },
        take: 1,
      },
    },
  });

  return colleges.map((college) => ({
    id: college.id,
    name: college.name,
    subdomain: college.subdomain,
    status: college.status,
    templateName: college.template?.name ?? null,
    owners: college._count.users,
    sections: college._count.sections,
    /** True for a college whose last owner was removed. */
    orphaned: college._count.users === 0,
    adoptable: college.adoptable,
    lastEditedAt: college.sections[0]?.lastSavedAt?.toISOString() ?? null,
    createdAt: college.createdAt.toISOString(),
  }));
}
