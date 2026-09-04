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
import { verifyGoogleIdToken } from "@/google-identity";
import { getDefaultWebsiteConfig } from "@/default-website-service";

/**
 * One work factor for every password this service stores, and one length floor.
 *
 * They were spread across four call sites at two different values - cost 8 on
 * the access-request form, 12 on activation and admin reset - and the cheapest
 * one governed most accounts, because the form's hash is the one that survives
 * approval. The floor was 8 characters on activation and absent on the form.
 */
export const PASSWORD_COST = 12;
export const MIN_ACCOUNT_PASSWORD_LENGTH = 10;

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
  /**
   * Optional, but when given it becomes the account's real password at
   * approval - so it carries the same floor as every other password on the
   * platform. It had none: `z.string().trim().optional()` accepted one
   * character, and `approveAccessRequest` copied the hash straight onto the
   * created user.
   */
  password: z
    .string()
    .trim()
    .min(
      MIN_ACCOUNT_PASSWORD_LENGTH,
      `Password must be at least ${MIN_ACCOUNT_PASSWORD_LENGTH} characters`,
    )
    .max(200, "Password is too long")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  organization: z.string().trim().max(160, "Organization name is too long").optional(),
  /**
   * A real field, because it was already being collected.
   *
   * The sign-up form asked for a mobile number and a website, then concatenated
   * them into `message` as `"Website: … | Mobile: …"`. `listAccessRequests`
   * returns `message: null` unconditionally, so the number reached the database
   * inside a prose string and was then never shown to the person whose job is
   * to ring it. Collected, stored, and invisible.
   *
   * The pattern is deliberately loose: digits, spaces, brackets, dashes and a
   * leading plus, seven to twenty characters. Tight enough to reject an email
   * address pasted into the wrong box, loose enough not to reject the way a
   * real number is written in a country whose format nobody here anticipated.
   */
  phone: z
    .string()
    .trim()
    .min(7, "Enter a valid phone number")
    .max(20, "Enter a valid phone number")
    .regex(/^\+?[0-9][0-9\s()\-.]*$/, "Enter a valid phone number")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  /**
   * The institution's existing website, if it has one.
   *
   * The other half of what was being folded into `message`, and kept for the
   * same reason: it is the fastest way for an administrator to check that an
   * application naming a college actually comes from that college. Stored as
   * typed — people write `www.example.ac.in` without a scheme, and rejecting
   * that would fail the common case to satisfy a URL parser.
   */
  website: z.string().trim().max(300, "Website address is too long").optional()
    .or(z.literal("").transform(() => undefined)),
  message: z.string().trim().max(2000, "Message is too long").optional(),
});

const orNull = (value: string | undefined) => (value ? value : null);

export async function submitAccessRequest(input: unknown) {
  const parsed = accessRequestSchema.safeParse(input);
  if (!parsed.success) {
    const firstMsg = parsed.error.issues[0]?.message || "Invalid input details";
    throw new AuthError(firstMsg, 400);
  }

  const { name, email, password, organization, phone, website, message } = parsed.data;
  const cleanEmail = email.trim().toLowerCase();

  try {
    const pending = await AccessRequest.findOne({ applicantEmail: cleanEmail, status: "PENDING" });

    let passwordHash: string | null = null;
    if (password && password.trim()) {
      /**
       * Cost 12, not 8.
       *
       * This hash is not a throwaway: `approveAccessRequest` copies it verbatim
       * onto the created account, so cost 8 here set the work factor for most
       * real user passwords on the platform - roughly sixteen times cheaper to
       * grind than the 12 used everywhere else in this codebase.
       */
      passwordHash = await bcrypt.hash(password.trim(), PASSWORD_COST);
    }

    const orgName = organization || name;
    const reqSubdomain = subdomainFromName(orgName);

    if (pending) {
      /**
       * A second request for an address that already has one changes nothing.
       *
       * This endpoint is public and unauthenticated - it has to be, it is the
       * front door - and it used to overwrite the pending row's `passwordHash`,
       * `collegeName` and `applicantName` with whatever the new caller sent.
       * Nothing proved the second caller was the first.
       *
       * So: submit a request naming somebody else's work address and a password
       * of your choosing, wait for the Super Admin to approve the row they
       * already had in their queue, and `approveAccessRequest` creates that
       * college's owner account carrying *your* hash. A takeover completed by
       * the administrator, against an application they believed they were
       * reading, with nothing anywhere recording that the row had changed hands.
       *
       * Re-submitting is still answered 202 with the same body, because callers
       * must not be able to tell whether an address is already in the queue. It
       * simply does not write.
       */
      await AuditLog.create({
        action: "ACCESS_REQUEST_DUPLICATE_IGNORED",
        tenantId: reqSubdomain,
        details: { email: cleanEmail },
      }).catch(() => null);

      return { received: true as const };
    } else {
      await AccessRequest.create({
        collegeName: orgName,
        applicantEmail: cleanEmail,
        applicantName: name,
        applicantPhone: phone ?? null,
        applicantWebsite: website ?? null,
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
    /**
     * A write that did not happen is not a request that was received.
     *
     * Every database error here used to be logged and then answered with
     * `{ received: true }` — the same 202 as a successful submission. Somebody
     * filled in the form, was told their request was in, and nothing was ever
     * written: no row, nothing in the Super Admin's queue, no account to
     * approve, and later no credentials to sign in with. The failure was
     * invisible on both ends at once.
     *
     * Answering 503 keeps the one property that *is* deliberate — a caller
     * still cannot tell whether an address already had a pending request,
     * because that path is a success, not an error.
     */
    console.error("[access-request] could not record request:", err);
    throw new AuthError(
      "We could not record your request just now. Please try again in a moment.",
      503,
    );
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
  phone: string | null;
  website: string | null;
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
    phone: row.applicantPhone ?? null,
    website: row.applicantWebsite ?? null,
    // Deliberately still null. There is no free-text message field on the form
    // any more — what used to be crammed in here is `phone` above — and a key
    // that always answers null is clearer than one quietly removed from a shape
    // the admin panel already destructures.
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

  /**
   * The password the new account is created with.
   *
   * The last branch used to be `bcrypt.hash("college123", 12)` - one literal,
   * committed to this repository, shared by every account approved without a
   * password of its own. The account is created ACTIVE and
   * `POST /api/v1/auth/login` accepts it immediately, so knowing any approved
   * applicant's email address was enough to sign in as the owner of their
   * college. This is the common branch, not an edge case: it is what every
   * request submitted without a password gets.
   *
   * It is a CSPRNG value nobody is ever told now. That is deliberately not a
   * usable credential - the way into such an account is the activation link the
   * approve route emails, which sets a password the applicant chooses. Filling
   * the field with randomness rather than leaving it empty keeps the account the
   * same shape as every other, so no code path has to reason about a user with
   * no hash.
   */
  let passwordHash: string;
  if (customPassword && customPassword.trim()) {
    if (customPassword.trim().length < MIN_ACCOUNT_PASSWORD_LENGTH) {
      throw new AuthError(
        `A password set here must be at least ${MIN_ACCOUNT_PASSWORD_LENGTH} characters.`,
        400,
      );
    }
    passwordHash = await bcrypt.hash(customPassword.trim(), PASSWORD_COST);
  } else if (request.passwordHash) {
    passwordHash = request.passwordHash;
  } else {
    passwordHash = await bcrypt.hash(randomBytes(32).toString("base64url"), PASSWORD_COST);
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

export async function deleteAccessRequest(id: string, actor: AdminSession) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw new AuthError("That request no longer exists", 404);
  const request = await AccessRequest.findById(id);
  if (!request) throw new AuthError("That request no longer exists", 404);

  await AccessRequest.findByIdAndDelete(id);

  await recordAudit({
    actor,
    action: "access_request.delete",
    targetType: "access_request",
    targetId: id,
    summary: `Deleted access request for ${request.applicantEmail}`,
    metadata: { email: request.applicantEmail, status: request.status },
  });

  return { deleted: true as const, id };
}

export async function removeAllAccessRequests(options: { status?: string } | undefined, actor: AdminSession) {
  const filter: Record<string, unknown> = {};
  if (options?.status && ["PENDING", "APPROVED", "REJECTED"].includes(options.status.toUpperCase())) {
    filter.status = options.status.toUpperCase();
  }

  const result = await AccessRequest.deleteMany(filter);

  await recordAudit({
    actor,
    action: "access_request.delete_all",
    targetType: "access_request",
    targetId: "all",
    summary: `Removed ${result.deletedCount || 0} access request(s)${filter.status ? ` with status ${filter.status}` : ""}`,
    metadata: { deletedCount: result.deletedCount, filter },
  });

  return { deletedCount: result.deletedCount, status: filter.status || "ALL" };
}

const tokenSchema = z
  .string({ error: "That activation link is not valid" })
  .trim()
  .regex(/^[a-f0-9]{64}$/, "That activation link is not valid");

export const activatePasswordSchema = z.object({
  token: tokenSchema,
  password: z
    .string({ error: "Choose a password" })
    .min(
      MIN_ACCOUNT_PASSWORD_LENGTH,
      `Password must be at least ${MIN_ACCOUNT_PASSWORD_LENGTH} characters`,
    )
    .max(200, "Password is too long"),
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

  const passwordHash = await bcrypt.hash(password, PASSWORD_COST);
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

  /**
   * Verified against Google's published keys, not believed.
   *
   * A local function was declared here that read, in full:
   *
   *     async function verifyGoogleIdToken(credential) { return { email: credential }; }
   *
   * It shadowed the real implementation in `google-identity.ts` - signature
   * check, issuer pinning, audience pinning against GOOGLE_CLIENT_ID, and an
   * `email_verified` requirement - with a function that echoed its own argument
   * back as the identity. The `identity.email !== request.applicantEmail`
   * comparison below therefore compared the invited address against a string the
   * caller had just chosen, and passed whenever the caller typed it.
   *
   * That comparison is the whole security boundary of activation-by-Google, as
   * both `google-identity.ts` and `.env.example` say at length: an invite is a
   * bearer token in an email, and without the match anyone who intercepts one
   * redeems it with their own account. It was documented, relied upon, and not
   * running.
   */
  const identity = await verifyGoogleIdToken(credential);
  const cleanEmail = request.applicantEmail.toLowerCase().trim();

  if (identity.email.toLowerCase().trim() !== cleanEmail) {
    throw new AuthError("Google account email does not match the invited address", 400);
  }

  const dummyPasswordHash = await bcrypt.hash(
    randomBytes(32).toString("base64url"),
    PASSWORD_COST,
  );
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
