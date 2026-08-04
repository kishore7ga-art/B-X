import { randomBytes } from "node:crypto";

import bcrypt from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import * as OTPAuth from "otpauth";
import { z } from "zod";

import { bootstrapState } from "@/admin-bootstrap";
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
  /**
   * Optional: the panel signs in on a password alone.
   *
   * The email is still the account's identity — it keys the row, labels the
   * TOTP enrolment and names the actor in the audit log — but the login form no
   * longer asks for it, so the password has to find the account by itself. Kept
   * accepted rather than removed because `scripts/admin.mjs` and any existing
   * client still send it, and naming the account is strictly more precise than
   * searching for it.
   */
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email"))
    .optional(),
  password: z.string().min(1, "Enter your password"),
  /** Six digits, and only checked when the account has enrolled. */
  token: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code").optional(),
});

/** The row in `service_secrets` this service signs admin sessions with. */
const ADMIN_SECRET_NAME = "admin_session";

/** Resolved once per process; the database is not asked again. */
let cachedSecret: Uint8Array | null = null;

/** Whether the environment supplied a usable key. */
function envSecret(): string | null {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  // Never the app's own key. That separation is why this is its own variable:
  // sharing one would make a forged college token a forged admin token.
  if (secret === process.env.SESSION_SECRET) return null;
  return secret;
}

/**
 * The key admin sessions are signed with.
 *
 * `ADMIN_SESSION_SECRET` wins whenever it is set to something usable. When it is
 * not, this generates 48 random bytes and keeps them in `service_secrets`, so
 * the panel works on a deployment nobody has configured yet and sessions survive
 * a restart instead of signing every admin out on deploy.
 *
 * That is a deliberate change of position. This used to throw 503 on every admin
 * route while the variable was missing, on the reasoning that missing
 * configuration should stop the admin surface rather than silently weaken it —
 * and the refusal was correct, but being stuck behind it is worse than the risk
 * it avoided. The panel is what an operator opens when something is wrong, the
 * 503 said nothing a browser could act on, and the only route out was an
 * environment variable on a service they had to identify first.
 *
 * Nothing is weakened to achieve it: the generated key is as strong as one you
 * would paste in, it is never `SESSION_SECRET`, and anybody who can read this
 * table can already read `admin_users.password_hash` and write themselves an
 * account. Setting the variable later takes precedence at the next restart, and
 * `service_secrets` can be cleared to rotate.
 */
async function adminSecret(): Promise<Uint8Array> {
  if (cachedSecret) return cachedSecret;

  const fromEnv = envSecret();
  if (fromEnv) {
    cachedSecret = new TextEncoder().encode(fromEnv);
    return cachedSecret;
  }

  const existing = await prisma.serviceSecret.findUnique({
    where: { name: ADMIN_SECRET_NAME },
  });

  if (existing) {
    cachedSecret = new TextEncoder().encode(existing.value);
    return cachedSecret;
  }

  const generated = randomBytes(48).toString("base64url");

  // Two workers booting together both find nothing and both insert. The unique
  // primary key makes one of them lose, and the loser wants the winner's value —
  // not its own, or the two would sign sessions the other cannot verify.
  const stored = await prisma.serviceSecret
    .create({ data: { name: ADMIN_SECRET_NAME, value: generated } })
    .then((row) => row.value)
    .catch(async () => {
      const row = await prisma.serviceSecret.findUnique({
        where: { name: ADMIN_SECRET_NAME },
      });
      if (!row) throw new AuthError("Could not establish an admin key", 503);
      return row.value;
    });

  console.warn(
    "[admin] ADMIN_SESSION_SECRET is not set, so a key was generated and " +
      "stored in service_secrets. Set the variable to control it yourself.",
  );

  cachedSecret = new TextEncoder().encode(stored);
  return cachedSecret;
}

/**
 * Whether the admin surface can serve at all, for the login screen and the
 * health check.
 *
 * Now true unless the database cannot be reached, because a key can always be
 * established. It stays a check rather than becoming `true` so that "the panel
 * cannot run" remains sayable — it just means something worse than a missing
 * variable now.
 */
export async function adminConfigured(): Promise<boolean> {
  if (envSecret()) return true;
  try {
    await adminSecret();
    return true;
  } catch {
    return false;
  }
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
  const bootstrap = bootstrapState();

  if (!(await adminConfigured())) {
    return { configured: false as const, hasAccounts: false, bootstrap };
  }
  try {
    return {
      configured: true as const,
      hasAccounts: (await prisma.adminUser.count()) > 0,
      bootstrap,
    };
  } catch {
    // The table is missing or the database is unreachable — either way setup
    // is not finished, which is what the caller is asking.
    return { configured: true as const, hasAccounts: false, bootstrap };
  }
}

async function mintAdminToken(payload: AdminSession) {
  return new SignJWT({ ...payload, kind: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_MAX_AGE_SECONDS}s`)
    .sign(await adminSecret());
}

/**
 * Whether a cookie set by `b` will be sent on a request from `a` under `Lax`.
 *
 * True for the same host, and for one being a parent of the other:
 * `api.xite.co.in` and `xite.co.in` pass, `admin.meetkishore.in` and
 * `api.xite.co.in` do not. Ports are deliberately ignored — they do not make a
 * site — which is what keeps `localhost:5174` calling `localhost:4000` on the
 * `Lax` path in development.
 *
 * Siblings are the deliberate imprecision: `admin.xite.co.in` and
 * `api.xite.co.in` *are* the same site, and this reports them as different, so
 * they get `None` where `Lax` would have done. Telling siblings apart from
 * `foo.co.in` and `bar.co.in` needs a public suffix list, and the cost of not
 * having one is a cookie marked less restrictively than it could be on requests
 * whose origin CORS has already had to allow by name. A wrong answer the other
 * way would be a panel that cannot stay signed in.
 */
function laxWouldReach(a: string, b: string): boolean {
  const one = a.split(":")[0]!.toLowerCase();
  const two = b.split(":")[0]!.toLowerCase();
  return one === two || one.endsWith(`.${two}`) || two.endsWith(`.${one}`);
}

/**
 * Cookie attributes for the admin session.
 *
 * Host-only on purpose, and the one place this service deliberately differs
 * from the college cookie: that one is scoped to the parent domain so both
 * services can read it. This one has no reason to travel anywhere except back
 * to the panel, so it does not.
 *
 * `SameSite` is decided per request rather than from configuration. It used to
 * be `lax` unless `SESSION_COOKIE_DOMAIN` was set, which meant a panel served
 * from a different domain than the API — `admin.meetkishore.in` calling
 * `api.xite.co.in` — signed in successfully and was then signed out on the very
 * next request, because a `Lax` cookie is not sent across sites. Nothing in that
 * failure points at a cookie: the login returns 200, the panel shows the account,
 * and every call after it answers 401.
 *
 * So a cross-site panel now gets `SameSite=None; Secure` because it has to. The
 * `Lax` CSRF protection that costs is not what is protecting these routes: every
 * state-changing admin call sends `Content-Type: application/json`, which a
 * cross-site form cannot set without a preflight, and the preflight is answered
 * against an allow-list of named origins. A same-site panel is unaffected and
 * keeps `Lax`.
 */
export function adminCookieOptions(
  origin?: string,
  host?: string,
): {
  httpOnly: true;
  sameSite: "none" | "lax";
  secure: boolean;
  path: string;
  maxAge: number;
  domain?: string;
} {
  const originHost = (() => {
    if (!origin) return undefined;
    try {
      return new URL(origin).host;
    } catch {
      return undefined;
    }
  })();

  const crossSite =
    Boolean(process.env.SESSION_COOKIE_DOMAIN) ||
    Boolean(originHost && host && !laxWouldReach(originHost, host));

  return {
    httpOnly: true,
    sameSite: crossSite ? "none" : "lax",
    // Required alongside SameSite=None, and a browser drops the cookie without
    // it. Localhost counts as a secure context, so development is unaffected.
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
  if (!(await adminConfigured())) return null;
  if (!cookieHeader) return null;

  let token: string | undefined;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === ADMIN_COOKIE_NAME) token = rest.join("=");
  }
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, await adminSecret());
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
 * A real bcrypt hash shape that nothing can match, for spending the same time
 * on a miss as on a hit.
 */
const DUMMY_HASH = `$2a$12$${"x".repeat(53)}`;

/**
 * The account a password belongs to.
 *
 * The login form asks for a password and nothing else, so the account has to be
 * found by the only thing offered. Every admin's hash is compared, in a fixed
 * order, and the work does not depend on which one matches or on whether any
 * does — an early return on the first hit would make "matched the first
 * account" measurably faster than "matched the last", and no accounts at all
 * faster still.
 *
 * The cost is one bcrypt comparison per admin account per attempt, which is why
 * this is only viable for a handful of them, and why the endpoint in front of it
 * is rate limited. Two admins may not share a password: the earlier account
 * wins, and the later one could never sign in. Nothing enforces that, because
 * enforcing it would mean comparing a new password against every existing hash
 * at the point it is set — the collision is astronomically unlikely and a
 * password-only panel is a deliberately small deployment.
 */
async function findAdminByPassword(password: string) {
  const admins = await prisma.adminUser.findMany({
    orderBy: { createdAt: "asc" },
  });

  if (admins.length === 0) {
    await bcrypt.compare(password, DUMMY_HASH);
    return null;
  }

  let match: (typeof admins)[number] | null = null;
  for (const admin of admins) {
    if (await bcrypt.compare(password, admin.passwordHash)) {
      match ??= admin;
    }
  }
  return match;
}

/**
 * Signs an admin in.
 *
 * One message for every failure — wrong password, missing or wrong code, and
 * wrong address for a caller that still sends one. Which admin accounts exist
 * is not something a login form should be willing to discuss.
 */
export async function adminLogin(input: unknown) {
  /**
   * Configuration is checked before anything else, and that ordering is the
   * whole point of it being here rather than further down.
   *
   * `mintAdminToken` reads the signing key, so an unconfigured deployment used
   * to fail at the last line of this function — after the password had already
   * been compared. A wrong password answered 401 and a right one answered 503,
   * which told anybody who cared to try that they had guessed correctly. A
   * login that cannot issue a session should not be willing to say whether the
   * password was right; the answer is the same either way now, and no bcrypt
   * work happens to produce it.
   */
  if (!(await adminConfigured())) {
    throw new AuthError("Admin panel is not configured on this deployment", 503);
  }

  const parsed = adminLoginSchema.safeParse(input);
  if (!parsed.success) {
    throw new AuthError(parsed.error.issues[0]?.message ?? "Check your details");
  }

  const { email, password, token } = parsed.data;
  const invalid = new AuthError(
    email ? "Incorrect email, password or code" : "Incorrect password or code",
    401,
  );

  const admin = email
    ? await prisma.adminUser.findUnique({ where: { email } })
    : await findAdminByPassword(password);

  if (!admin) {
    // Comparable work for a missing account, so absence is not obvious from
    // how quickly this answers. `findAdminByPassword` has already done its own.
    if (email) await bcrypt.compare(password, DUMMY_HASH);
    throw invalid;
  }

  // Only when the account was named. Finding it by password is the comparison.
  if (email && !(await bcrypt.compare(password, admin.passwordHash))) {
    throw invalid;
  }

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

export const updateUserStatusSchema = z.object({
  status: z.enum(["ACTIVE", "DISABLED"], {
    error: "status must be ACTIVE or DISABLED",
  }),
});

export async function listUsersForAdmin() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      status: true,
      createdAt: true,
      college: {
        select: {
          id: true,
          name: true,
          subdomain: true,
        },
      },
    },
  });

  return users.map((user) => ({
    ...user,
    createdAt: user.createdAt.toISOString(),
  }));
}

export async function updateUserStatusForAdmin(
  userId: string,
  input: unknown,
  actor: AdminSession,
) {
  const { status } = updateUserStatusSchema.parse(input);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, status: true },
  });

  if (!user) throw new AuthError("User not found", 404);

  const updated = await prisma.user.update({
    where: { id: userId },
    data: { status },
    select: {
      id: true,
      email: true,
      status: true,
      createdAt: true,
      college: {
        select: {
          id: true,
          name: true,
          subdomain: true,
        },
      },
    },
  });

  await recordAudit({
    actor,
    action: "user.update_status",
    targetType: "user",
    targetId: userId,
    summary: `Updated status for ${user.email} to ${status}`,
    metadata: { email: user.email, status },
  });

  return {
    user: {
      ...updated,
      createdAt: updated.createdAt.toISOString(),
    },
  };
}

export const updateUserPasswordSchema = z.object({
  password: z.string().trim().min(1, "Password cannot be empty"),
});

export async function updateUserPasswordForAdmin(
  userId: string,
  input: unknown,
  actor: AdminSession,
) {
  const { password } = updateUserPasswordSchema.parse(input);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true },
  });

  if (!user) throw new AuthError("User not found", 404);

  const passwordHash = await bcrypt.hash(password, 12);
  const normalizedEmail = user.email.trim().toLowerCase();

  await prisma.user.update({
    where: { id: userId },
    data: {
      email: normalizedEmail,
      passwordHash,
      status: "ACTIVE",
    },
  });

  await recordAudit({
    actor,
    action: "user.update_password",
    targetType: "user",
    targetId: userId,
    summary: `Updated password for ${normalizedEmail}`,
    metadata: { email: normalizedEmail },
  });

  return { success: true, email: normalizedEmail };
}

export async function deleteUserForAdmin(userId: string, actor: AdminSession) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, collegeId: true },
  });

  if (!user) throw new AuthError("User not found", 404);

  const userEmail = user.email;

  // Delete user record
  await prisma.user.delete({
    where: { id: userId },
  });

  // Clean up college if no remaining users
  if (user.collegeId) {
    const remaining = await prisma.user.count({ where: { collegeId: user.collegeId } });
    if (remaining === 0) {
      await prisma.college.delete({ where: { id: user.collegeId } }).catch(() => {});
    }
  }

  // Clean up access requests for this email so they can submit fresh requests
  await prisma.accessRequest.deleteMany({
    where: { email: userEmail },
  }).catch(() => {});

  await recordAudit({
    actor,
    action: "user.delete",
    targetType: "user",
    targetId: userId,
    summary: `Deleted user account ${userEmail}`,
    metadata: { email: userEmail },
  });

  return { success: true, email: userEmail };
}

