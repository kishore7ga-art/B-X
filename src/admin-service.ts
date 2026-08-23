import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { jwtVerify, SignJWT } from "jose";
import * as OTPAuth from "otpauth";
import { z } from "zod";

import { bootstrapState } from "@/admin-bootstrap";
import { AdminUser, SystemSecret, College, Template } from "@/models";
import type { IAdminUser } from "@/models/admin_users.model";
import { AuthError } from "@/auth-service";

export const ADMIN_COOKIE_NAME = "xite_admin_session";
const ADMIN_MAX_AGE_SECONDS = 60 * 60 * 8;

export const adminLoginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email"))
    .optional(),
  password: z.string().min(1, "Enter your password"),
  token: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code").optional(),
});

const ADMIN_SECRET_NAME = "admin_session";
let cachedSecret: Uint8Array | null = null;

function envSecret(): string | null {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32) return null;
  if (secret === process.env.SESSION_SECRET) return null;
  return secret;
}

async function adminSecret(): Promise<Uint8Array> {
  if (cachedSecret) return cachedSecret;

  const fromEnv = envSecret();
  if (fromEnv) {
    cachedSecret = new TextEncoder().encode(fromEnv);
    return cachedSecret;
  }

  const existing = await SystemSecret.findOne({ name: ADMIN_SECRET_NAME });

  if (existing) {
    cachedSecret = new TextEncoder().encode(typeof existing.value === "string" ? existing.value : String(existing.value));
    return cachedSecret;
  }

  const generated = randomBytes(48).toString("base64url");
  const stored = await SystemSecret.findOneAndUpdate(
    { name: ADMIN_SECRET_NAME },
    { name: ADMIN_SECRET_NAME, value: generated },
    { upsert: true, new: true }
  );

  cachedSecret = new TextEncoder().encode(String(stored.value));
  return cachedSecret;
}

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

export async function adminStatus() {
  const bootstrap = bootstrapState();

  if (!(await adminConfigured())) {
    return { configured: false as const, hasAccounts: false, bootstrap };
  }
  try {
    const count = await AdminUser.countDocuments();
    return {
      configured: true as const,
      hasAccounts: count > 0,
      bootstrap,
    };
  } catch {
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

function laxWouldReach(a: string, b: string): boolean {
  const one = a.split(":")[0]!.toLowerCase();
  const two = b.split(":")[0]!.toLowerCase();
  return one === two || one.endsWith(`.${two}`) || two.endsWith(`.${one}`);
}

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

  const domain = (() => {
    if (process.env.SESSION_COOKIE_DOMAIN) return process.env.SESSION_COOKIE_DOMAIN;
    if (originHost && host) {
      const oParts = originHost.split(".");
      const hParts = host.split(".");
      if (oParts.length >= 2 && hParts.length >= 2) {
        const oParent = oParts.slice(-2).join(".");
        const hParent = hParts.slice(-2).join(".");
        if (oParent === hParent && oParent.includes(".")) return `.${oParent}`;
      }
    }
    return undefined;
  })();

  const crossSite =
    Boolean(domain) ||
    Boolean(originHost && host && !laxWouldReach(originHost, host));

  return {
    httpOnly: true,
    sameSite: crossSite ? "none" : "lax",
    secure: crossSite || process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ADMIN_MAX_AGE_SECONDS * 1000,
    ...(domain ? { domain } : {}),
  };
}

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
    if (payload.kind !== "admin") return null;
    const { adminId, email } = payload;
    if (typeof adminId !== "string" || typeof email !== "string") return null;
    return { adminId, email };
  } catch {
    return null;
  }
}

/**
 * A bcrypt hash nothing can match, compared against so that a miss costs the
 * same wall-clock time as a hit. Without it, "no such admin" answers instantly
 * and "wrong password" answers in bcrypt time, which enumerates the admin roster
 * from a stopwatch.
 */
const DUMMY_HASH = `$2a$12$${"x".repeat(53)}`;

/**
 * Signing in as a Super Admin.
 *
 * What was here before contained a hardcoded universal password. The literal
 * string "2008" was accepted three separate ways, and each one was on its own
 * sufficient to take over the entire platform from an unauthenticated request:
 *
 *   1. `AdminUser.create({ email: targetEmail, ... })` when no admin matched —
 *      so POST with any email address and that password *minted a new
 *      SUPER_ADMIN account* for the caller.
 *   2. A synthetic `super-admin-root` session returned when no admin row
 *      existed at all, signed with the real admin key.
 *   3. `if (!match && password !== "2008")` — for an admin that *did* exist,
 *      the bcrypt comparison's result was discarded, so the real password was
 *      never required. The same clause appeared again on the TOTP branch, so
 *      second-factor enrolment was bypassed by the same string.
 *
 * `ADMIN_BOOTSTRAP_PASSWORD` was checked identically alongside it, which made
 * the bootstrap credential a permanent standing password rather than a one-time
 * setup value, and made rotating the admin's real password change nothing.
 *
 * None of that survives. There is exactly one way in now: an AdminUser row
 * whose stored bcrypt hash matches the password presented, plus its TOTP code
 * if one is enrolled. Provisioning the first administrator is `bootstrapAdmin`'s
 * job and happens at boot, not inside a login handler.
 */
export async function adminLogin(input: unknown) {
  const parsed = adminLoginSchema.safeParse(input);
  if (!parsed.success) {
    throw new AuthError(parsed.error.issues[0]?.message ?? "Check your details");
  }

  const { email, password, token } = parsed.data;

  /**
   * Which account is being signed into, and only that one.
   *
   * `findAdminByPassword` used to try the presented password against *every*
   * administrator and sign in as whichever one matched, so the email field was
   * decorative and one guess was tested against the whole roster at once. An
   * email that names no admin is now a failure, not a search.
   */
  const targetEmail = (email || process.env.ADMIN_BOOTSTRAP_EMAIL || "")
    .trim()
    .toLowerCase();

  if (!targetEmail) {
    throw new AuthError("Enter your email address", 400);
  }

  let admin: IAdminUser | null = null;
  try {
    admin = await AdminUser.findOne({ email: targetEmail });
  } catch (dbError) {
    /**
     * A database this handler cannot reach is not an authentication decision.
     *
     * The previous version swallowed the error into `admin = null` and fell
     * through to the backdoor, so a database outage was itself a way in. 503
     * says what happened and grants nothing.
     */
    console.error("[admin] login lookup failed:", (dbError as Error).message);
    throw new AuthError("Sign-in is temporarily unavailable. Try again shortly.", 503);
  }

  // Same message and same cost whether the address is unknown or the password
  // is wrong, so neither can be used to enumerate administrators.
  const invalid = new AuthError("Incorrect email, password or code", 401);

  if (!admin) {
    await bcrypt.compare(password, DUMMY_HASH);
    throw invalid;
  }

  const match = await bcrypt.compare(password, admin.passwordHash).catch(() => false);
  if (!match) throw invalid;

  /**
   * The second factor, with no way past it.
   *
   * Enrolled means required. The clause that let `ADMIN_BOOTSTRAP_PASSWORD` or
   * "2008" satisfy this branch is gone — a second factor a password can skip is
   * not a second factor.
   */
  if (admin.totpSecret) {
    if (!token) throw new AuthError("A 6-digit code is required", 401);

    const totp = new OTPAuth.TOTP({
      issuer: "XITE",
      label: admin.email,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(admin.totpSecret),
    });

    if (totp.validate({ token, window: 1 }) === null) {
      throw new AuthError("Incorrect 6-digit code", 401);
    }
  }

  return {
    token: await mintAdminToken({ adminId: admin.id, email: admin.email }),
    admin: {
      id: admin.id,
      email: admin.email,
      totpEnrolled: Boolean(admin.totpSecret),
    },
  };
}

export function recordAudit(entry: {
  actor: AdminSession;
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
}): void {
  // Fire-and-forget: runs AFTER response is sent, never blocks or crashes the caller
  setImmediate(async () => {
    try {
      await SystemSecret.create({
        name: `audit:${Date.now()}:${Math.random().toString(36).substring(2, 7)}`,
        value: {
          actorId: entry.actor.adminId,
          actorEmail: entry.actor.email,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId ?? null,
          summary: entry.summary,
          metadata: entry.metadata,
          createdAt: new Date(),
        },
      });
    } catch (error) {
      console.error("[admin] audit write failed (non-fatal):", (error as Error).message);
    }
  });
}

export async function adminOverview() {
  const [
    collegesTotal,
    published,
    withoutTemplate,
    templates,
    collegesWithUsers,
  ] = await Promise.all([
    College.countDocuments({ isDemo: false }),
    College.countDocuments({ isDemo: false, status: "ACTIVE" }),
    College.countDocuments({ isDemo: false, templateId: null }),
    Template.find().sort({ name: 1 }),
    College.find({ isDemo: false }).select("users"),
  ]);

  let userCount = 0;
  collegesWithUsers.forEach((c) => { userCount += c.users?.length || 0; });

  return {
    colleges: {
      total: collegesTotal,
      published,
      onboardingIncomplete: withoutTemplate,
    },
    users: userCount,
    templates: templates.map((t) => ({
      id: t.id,
      name: t.name,
      colleges: 0,
      archived: Boolean(t.archivedAt),
    })),
    recentActions: [],
  };
}

export async function adminSites() {
  const colleges = await College.find({ isDemo: false }).sort({ createdAt: -1 });

  return colleges.map((college) => ({
    id: college.id,
    name: college.name,
    subdomain: college.subdomain,
    status: college.status,
    templateName: null,
    owners: college.users?.length || 0,
    sections: college.websiteConfig?.pages?.reduce((sum: number, p: any) => sum + (p.sections?.length || 0), 0) || 0,
    orphaned: (college.users?.length || 0) === 0,
    adoptable: college.adoptable,
    lastEditedAt: college.updatedAt?.toISOString() ?? null,
    createdAt: college.createdAt?.toISOString() ?? new Date().toISOString(),
  }));
}

export const updateUserStatusSchema = z.object({
  status: z.enum(["ACTIVE", "DISABLED"], {
    error: "status must be ACTIVE or DISABLED",
  }),
});

export async function listUsersForAdmin() {
  const colleges = await College.find().sort({ createdAt: -1 });
  const result: Array<{ id: string; email: string; status: string; createdAt: string; college: { id: string; name: string; subdomain: string } }> = [];

  colleges.forEach((c) => {
    (c.users || []).forEach((u: any) => {
      result.push({
        id: u.id,
        email: u.email,
        status: u.status,
        createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : new Date().toISOString(),
        college: {
          id: c.id,
          name: c.name,
          subdomain: c.subdomain,
        },
      });
    });
  });

  return result;
}

export async function updateUserStatusForAdmin(
  userId: string,
  input: unknown,
  actor: AdminSession,
) {
  const { status } = updateUserStatusSchema.parse(input);

  const college = await College.findOne({ "users.id": userId });
  if (!college) throw new AuthError("User not found", 404);

  const user = college.users.find((u: any) => u.id === userId);
  if (!user) throw new AuthError("User not found", 404);

  user.status = status;
  await college.save();

  recordAudit({
    actor,
    action: "user.update_status",
    targetType: "user",
    targetId: userId,
    summary: `Updated status for ${user.email} to ${status}`,
    metadata: { email: user.email, status },
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      status: user.status,
      createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : new Date().toISOString(),
      college: {
        id: college.id,
        name: college.name,
        subdomain: college.subdomain,
      },
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

  const college = await College.findOne({ "users.id": userId });
  if (!college) throw new AuthError("User not found", 404);

  const user = college.users.find((u: any) => u.id === userId);
  if (!user) throw new AuthError("User not found", 404);

  user.passwordHash = await bcrypt.hash(password, 12);
  user.status = "ACTIVE";
  await college.save();

  recordAudit({
    actor,
    action: "user.update_password",
    targetType: "user",
    targetId: userId,
    summary: `Updated password for ${user.email}`,
    metadata: { email: user.email },
  });

  return { success: true, email: user.email };
}

export async function deleteUserForAdmin(userId: string, actor: AdminSession) {
  const college = await College.findOne({ "users.id": userId });
  if (!college) throw new AuthError("User not found", 404);

  const userIndex = college.users.findIndex((u: any) => u.id === userId);
  if (userIndex === -1) throw new AuthError("User not found", 404);

  const userEmail = college.users[userIndex].email;
  college.users.splice(userIndex, 1);

  if (college.users.length === 0) {
    await College.deleteOne({ _id: college._id });
  } else {
    await college.save();
  }

  recordAudit({
    actor,
    action: "user.delete",
    targetType: "user",
    targetId: userId,
    summary: `Deleted user account ${userEmail}`,
    metadata: { email: userEmail },
  });

  return { success: true, email: userEmail };
}
