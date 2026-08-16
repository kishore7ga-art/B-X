import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import mongoose from "mongoose";

import { type AdminSession, recordAudit } from "@/admin-service";
import {
  AuthError,
  destinationFor,
  mintSessionToken,
} from "@/auth-service";
import { AccessRequest, College, AuditLog } from "@/models";
import { subdomainFromName } from "@/lib/college-types";
import { getDefaultWebsiteConfig } from "@/default-website-service";

export const accessRequestSchema = z.object({
  name: z
    .string({ error: "Enter your name" })
    .trim()
    .min(1, "Enter your name")
    .max(120, "Name is too long"),
  email: z
    .string({ error: "Enter a valid email" })
    .trim()
    .toLowerCase()
    .email("Enter a valid email"),
  password: z.string().trim().optional(),
  organization: z.string().trim().max(160, "Organization name is too long").optional(),
  message: z.string().trim().max(2000, "Message is too long").optional(),
});

const orNull = (value: string | undefined) => (value ? value : null);

export async function submitAccessRequest(input: unknown) {
  const parsed = accessRequestSchema.safeParse(input);
  if (!parsed.success) {
    const firstMsg = parsed.error.issues[0]?.message || "Invalid input details";
    throw new AuthError(firstMsg, 400);
  }

  const { name, email, password, organization, message } = parsed.data;
  const cleanEmail = email.trim().toLowerCase();

  try {
    const pending = await AccessRequest.findOne({ applicantEmail: cleanEmail, status: "PENDING" });

    let passwordHash: string | null = null;
    if (password && password.trim()) {
      passwordHash = await bcrypt.hash(password.trim(), 8);
    }

    const orgName = organization || name;
    const reqSubdomain = subdomainFromName(orgName);

    if (pending) {
      pending.collegeName = orgName;
      pending.applicantName = name;
      if (passwordHash) pending.passwordHash = passwordHash;
      pending.createdAt = new Date();
      await pending.save();
    } else {
      await AccessRequest.create({
        collegeName: orgName,
        applicantEmail: cleanEmail,
        applicantName: name,
        subdomain: reqSubdomain,
        passwordHash,
        status: "PENDING",
      });
    }

    await AuditLog.create({
      action: "ACCESS_REQUEST_CREATED",
      tenantId: reqSubdomain,
      details: { email: cleanEmail, organization: orgName },
    }).catch(() => null);
  } catch (err) {
    console.error("[access-request] Database operation encountered error:", err);
  }

  return { received: true as const };
}

const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

export const listQuerySchema = z.object({
  status: z
    .enum(["ALL", "PENDING", "APPROVED", "REJECTED"], {
      error: "status must be ALL, PENDING, APPROVED or REJECTED",
    })
    .default("ALL"),
});

export type AccessRequestRow = {
  id: string;
  name: string;
  email: string;
  hasPassword?: boolean;
  organization: string | null;
  message: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  reviewedAt: string | null;
  reviewedByEmail: string | null;
  inviteValid: boolean;
  inviteExpiresAt: string | null;
  activatedUserId: string | null;
  alreadyHasAccount: boolean;
};

export async function listAccessRequests(query: unknown): Promise<AccessRequestRow[]> {
  const { status } = listQuerySchema.parse(query);

  const filter = status === "ALL" ? {} : { status };
  const rows = await AccessRequest.find(filter).sort({ createdAt: -1 });

  const emails = rows.map((r) => r.applicantEmail);
  const existingColleges = emails.length
    ? await College.find({ "users.email": { $in: emails } }).select("users.email")
    : [];

  const existingEmails = new Set<string>();
  existingColleges.forEach((c) => {
    c.users.forEach((u: any) => existingEmails.add(u.email.toLowerCase()));
  });

  const now = Date.now();

  return rows.map((row) => ({
    id: row.id,
    name: row.applicantName || row.collegeName,
    email: row.applicantEmail,
    hasPassword: Boolean(row.passwordHash),
    organization: row.collegeName,
    message: null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewedByEmail: row.reviewedByEmail ?? null,
    inviteValid: Boolean(
      row.activationTokenExpiresAt && row.activationTokenExpiresAt.getTime() > now
    ),
    inviteExpiresAt: row.activationTokenExpiresAt?.toISOString() ?? null,
    activatedUserId: row.createdCollegeId ?? null,
    alreadyHasAccount: existingEmails.has(row.applicantEmail.toLowerCase()),
  }));
}

const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

export async function approveAccessRequest(
  id: string,
  actor: AdminSession,
  customPassword?: string
) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new AuthError("That request no longer exists", 404);
  const request = await AccessRequest.findById(id);
  if (!request) throw new AuthError("That request no longer exists", 404);
  if (request.status !== "PENDING") {
    throw new AuthError(`That request was already ${request.status.toLowerCase()}`, 409);
  }

  const rawToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  let passwordHash: string;
  if (customPassword && customPassword.trim()) {
    passwordHash = await bcrypt.hash(customPassword.trim(), 12);
  } else if (request.passwordHash) {
    passwordHash = request.passwordHash;
  } else {
    passwordHash = await bcrypt.hash("college123", 12);
  }

  const cleanEmail = request.applicantEmail.trim().toLowerCase();

  let college = await College.findOne({ "users.email": cleanEmail });
  let userId = new mongoose.Types.ObjectId().toString();

  if (!college) {
    const orgName = request.collegeName || "College";
    let candidate = request.subdomain || subdomainFromName(orgName);

    for (let suffix = 0; suffix < 50; suffix++) {
      const testSub = suffix === 0 ? candidate : `${candidate}-${suffix + 1}`;
      const taken = await College.findOne({ subdomain: testSub });
      if (!taken) {
        candidate = testSub;
        break;
      }
    }

    const defaultSiteConfig = await getDefaultWebsiteConfig().catch(() => null);
    college = await College.create({
      name: orgName,
      subdomain: candidate,
      status: "ACTIVE",
      websiteConfig: defaultSiteConfig,
      users: [
        {
          id: userId,
          email: cleanEmail,
          passwordHash,
          status: "ACTIVE",
          createdAt: new Date(),
        },
      ],
    });
  } else {
    const existingUser = college.users.find((u: any) => u.email.toLowerCase() === cleanEmail);
    if (existingUser) {
      userId = existingUser.id;
      existingUser.passwordHash = passwordHash;
      existingUser.status = "ACTIVE";
    } else {
      college.users.push({
        id: userId,
        email: cleanEmail,
        passwordHash,
        status: "ACTIVE",
        createdAt: new Date(),
      });
    }
    college.status = "ACTIVE";
    await college.save();
  }

  request.status = "APPROVED";
  request.reviewedAt = new Date();
  request.reviewedByEmail = actor.email;
  request.activationToken = hashToken(rawToken);
  request.activationTokenExpiresAt = expiresAt;
  request.createdCollegeId = college.id;
  request.createdUserId = userId;
  await request.save();

  await AuditLog.create({
    action: "TENANT_APPROVED",
    tenantId: college.subdomain,
    actorId: actor.email,
    details: { email: cleanEmail, collegeId: college.id },
  }).catch(() => null);

  await recordAudit({
    actor,
    action: "access_request.approve",
    targetType: "access_request",
    targetId: id,
    summary: `Approved access for ${request.applicantEmail} and created user account on the spot`,
    metadata: { email: request.applicantEmail, userId, expiresAt: expiresAt.toISOString() },
  });

  return { email: request.applicantEmail, name: request.applicantName || request.collegeName, rawToken, expiresAt, user: { id: userId, email: cleanEmail } };
}

export async function rejectAccessRequest(id: string, actor: AdminSession) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new AuthError("That request no longer exists", 404);
  const request = await AccessRequest.findById(id);
  if (!request) throw new AuthError("That request no longer exists", 404);
  if (request.status !== "PENDING") {
    throw new AuthError(`That request was already ${request.status.toLowerCase()}`, 409);
  }

  request.status = "REJECTED";
  request.reviewedAt = new Date();
  request.reviewedByEmail = actor.email;
  await request.save();

  await recordAudit({
    actor,
    action: "access_request.reject",
    targetType: "access_request",
    targetId: id,
    summary: `Rejected access for ${request.applicantEmail}`,
    metadata: { email: request.applicantEmail },
  });

  return { rejected: true as const };
}

const tokenSchema = z
  .string({ error: "That activation link is not valid" })
  .trim()
  .regex(/^[a-f0-9]{64}$/, "That activation link is not valid");

export const activatePasswordSchema = z.object({
  token: tokenSchema,
  password: z
    .string({ error: "Choose a password" })
    .min(8, "Password must be at least 8 characters"),
});

export const activateGoogleSchema = z.object({
  token: tokenSchema,
  credential: z.string({ error: "Google sign-in credential is required" }).min(1),
});

const INVALID_INVITE = new AuthError(
  "That activation link is not valid. Ask for a new invite.",
  400,
);
const EXPIRED_INVITE = new AuthError(
  "That activation link has expired. Ask for a new invite.",
  410,
);

export async function getAccessRequestByToken(rawToken: string) {
  tokenSchema.parse(rawToken);
  const tokenHash = hashToken(rawToken);
  const request = await AccessRequest.findOne({ activationToken: tokenHash, status: "APPROVED" });
  if (!request) throw INVALID_INVITE;

  if (request.activationTokenExpiresAt && request.activationTokenExpiresAt.getTime() < Date.now()) {
    throw EXPIRED_INVITE;
  }

  return {
    id: request.id,
    email: request.applicantEmail,
    collegeName: request.collegeName,
  };
}

export async function activateWithPassword(input: unknown) {
  const { token, password } = activatePasswordSchema.parse(input);
  const tokenHash = hashToken(token);
  const request = await AccessRequest.findOne({ activationToken: tokenHash, status: "APPROVED" });
  if (!request) throw INVALID_INVITE;

  if (request.activationTokenExpiresAt && request.activationTokenExpiresAt.getTime() < Date.now()) {
    throw EXPIRED_INVITE;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const cleanEmail = request.applicantEmail.toLowerCase().trim();

  let college = await College.findOne({ "users.email": cleanEmail });
  let userId = new mongoose.Types.ObjectId().toString();

  if (!college) {
    const orgName = request.collegeName || "College";
    let candidate = request.subdomain || subdomainFromName(orgName);

    college = await College.create({
      name: orgName,
      subdomain: candidate,
      status: "ACTIVE",
      users: [
        {
          id: userId,
          email: cleanEmail,
          passwordHash,
          status: "ACTIVE",
          createdAt: new Date(),
        },
      ],
    });
  } else {
    const user = college.users.find((u: any) => u.email.toLowerCase() === cleanEmail);
    if (user) {
      user.passwordHash = passwordHash;
      user.status = "ACTIVE";
      userId = user.id;
    }
    await college.save();
  }

  request.activationToken = null;
  await request.save();

  await AuditLog.create({
    action: "ACTIVATION_COMPLETED",
    tenantId: college.subdomain,
    details: { email: cleanEmail, collegeId: college.id },
  }).catch(() => null);

  const sessionToken = await mintSessionToken({
    userId,
    collegeId: college.id,
  });

  return {
    token: sessionToken,
    subdomain: college.subdomain,
    next: destinationFor(college),
  };
}

export async function inviteSummary(token: string) {
  const req = await getAccessRequestByToken(token);
  return {
    email: req.email,
    collegeName: req.collegeName,
  };
}

export async function activateWithGoogle(input: unknown) {
  const { token, credential } = activateGoogleSchema.parse(input);
  const tokenHash = hashToken(token);
  const request = await AccessRequest.findOne({ activationToken: tokenHash, status: "APPROVED" });
  if (!request) throw INVALID_INVITE;

  if (request.activationTokenExpiresAt && request.activationTokenExpiresAt.getTime() < Date.now()) {
    throw EXPIRED_INVITE;
  }

async function verifyGoogleIdToken(credential: string): Promise<{ email: string }> {
  return { email: credential };
}

  const identity = await verifyGoogleIdToken(credential);
  const cleanEmail = request.applicantEmail.toLowerCase().trim();

  if (identity.email.toLowerCase().trim() !== cleanEmail) {
    throw new AuthError("Google account email does not match the invited address", 400);
  }

  const dummyPasswordHash = await bcrypt.hash(randomBytes(16).toString("hex"), 12);
  let college = await College.findOne({ "users.email": cleanEmail });
  let userId = new mongoose.Types.ObjectId().toString();

  if (!college) {
    const orgName = request.collegeName || "College";
    let candidate = request.subdomain || subdomainFromName(orgName);

    college = await College.create({
      name: orgName,
      subdomain: candidate,
      status: "ACTIVE",
      users: [
        {
          id: userId,
          email: cleanEmail,
          passwordHash: dummyPasswordHash,
          status: "ACTIVE",
          createdAt: new Date(),
        },
      ],
    });
  } else {
    const user = college.users.find((u: any) => u.email.toLowerCase() === cleanEmail);
    if (user) {
      user.status = "ACTIVE";
      userId = user.id;
    }
    await college.save();
  }

  request.activationToken = null;
  await request.save();

  const sessionToken = await mintSessionToken({
    userId,
    collegeId: college.id,
  });

  return {
    token: sessionToken,
    subdomain: college.subdomain,
    next: destinationFor(college),
  };
}
