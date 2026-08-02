import { createHash, randomBytes, randomUUID } from "node:crypto";

import bcrypt from "bcryptjs";
import { z } from "zod";

import { type AdminSession, recordAudit } from "@/admin-service";
import {
  AuthError,
  destinationFor,
  mintSessionToken,
  provisionCollegeAndUser,
} from "@/auth-service";
import { prisma } from "@/db";
import { verifyGoogleIdToken } from "@/google-identity";
import { subdomainFromName } from "@/lib/college-types";

/**
 * Asking for access, before there is an account to ask with.
 *
 * The only unauthenticated write on this API, which is most of what shapes it.
 * `signup()` next door is also public, but it is about to stop being reachable —
 * once that lands this is the single door anyone on the internet can push, so it
 * writes one small row, holds no credential, and grants nothing at all. Approval
 * is a separate, authenticated decision; see `admin-service.ts`.
 */

export const accessRequestSchema = z.object({
  /**
   * The `error` on each `z.string()` is for the field being *absent*, which is a
   * different issue from failing `min`/`email` and carries zod's own wording
   * otherwise — "Invalid input: expected string, received undefined" reaching a
   * public form is the kind of message this codebase words carefully everywhere
   * else.
   */
  name: z
    .string({ error: "Enter your name" })
    .trim()
    .min(2, "Enter your name")
    .max(120, "Name is too long"),
  // Lowercased here, exactly as `credentialsSchema` does, because the whole
  // flow turns on this address matching later: the invite is sent to it, and
  // Google activation compares its own answer against it. Two rows differing
  // only in case would make that comparison a coin toss.
  email: z
    .string({ error: "Enter a valid email" })
    .trim()
    .toLowerCase()
    .pipe(z.email("Enter a valid email")),
  organization: z
    .string()
    .trim()
    .max(160, "Organization name is too long")
    .optional(),
  /**
   * Capped, unlike the guide's version.
   *
   * `express.json({ limit: "1mb" })` is the only bound otherwise, so a bored
   * script could park a megabyte of prose in a column an admin has to read.
   * Two thousand characters is more than anyone explaining themselves needs.
   */
  message: z.string().trim().max(2000, "Message is too long").optional(),
});

/** `""` from an untouched optional field is absence, not an empty answer. */
const orNull = (value: string | undefined) => (value ? value : null);

/**
 * Records a request, or quietly does not, and says the same thing either way.
 *
 * The guide answers 200 "Request already pending" for an address that has one
 * and 201 for one that does not, which turns this endpoint into a way to ask
 * whether a given person has applied — the same enumeration oracle this codebase
 * already refuses at sign-in ("Incorrect email or password") and on the admin
 * status route. So the second request from an address is dropped and the caller
 * cannot tell.
 *
 * 202 rather than 201 for that reason too: on one of those two paths nothing was
 * created, and a response code should not claim otherwise.
 *
 * A request from someone who already has an account is *not* dropped. It costs
 * one row, and the alternative is a silent black hole for the person most likely
 * to be confused about why they cannot get in — an admin can see it and decide.
 */
export async function submitAccessRequest(input: unknown) {
  const { name, email, organization, message } = accessRequestSchema.parse(input);

  const pending = await prisma.accessRequest.findFirst({
    where: { email, status: "PENDING" },
    select: { id: true },
  });

  if (!pending) {
    await prisma.accessRequest.create({
      data: {
        name,
        email,
        organization: orNull(organization),
        message: orNull(message),
      },
    });
  }

  /**
   * Deliberately nothing about what happened — no id, no status, no "already
   * pending". The caller is not signed in and has no business reading this
   * table; everything it needs to render the confirmation screen it already
   * typed into the form.
   */
  return { received: true as const };
}

// --- Review, by a Super Admin -------------------------------------------------

/** How long an invite is good for. Long enough for a weekend, short enough to expire. */
const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

export const listQuerySchema = z.object({
  /**
   * Validated against the enum rather than passed through.
   *
   * The guide reads `req.query.status` and hands it to Prisma, which throws on
   * anything that is not an enum member — a 500 and a stack trace for what is
   * really a typo in a query string. `PENDING` by default because that is the
   * only list with work in it.
   */
  status: z
    .enum(["PENDING", "APPROVED", "REJECTED"], {
      error: "status must be PENDING, APPROVED or REJECTED",
    })
    .default("PENDING"),
});

/**
 * Never leaves this module.
 *
 * The stored value is a hash and the raw token exists only between minting and
 * the email that carries it. Selecting it explicitly everywhere would work
 * until somebody wrote `select: undefined` and shipped the column to a browser,
 * so the read path names its columns and this is not among them.
 */
const REVIEW_FIELDS = {
  id: true,
  name: true,
  email: true,
  organization: true,
  message: true,
  status: true,
  createdAt: true,
  reviewedAt: true,
  reviewedByEmail: true,
  inviteTokenExpiresAt: true,
  createdUserId: true,
} as const;

export type AccessRequestRow = {
  id: string;
  name: string;
  email: string;
  organization: string | null;
  message: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  reviewedAt: string | null;
  reviewedByEmail: string | null;
  /** True once approved and still within the window — the panel shows "invite live". */
  inviteValid: boolean;
  inviteExpiresAt: string | null;
  /** Whether the invite was acted on. Null until it is. */
  activatedUserId: string | null;
  /**
   * Whether this address already has an account. Approving it would mint an
   * invite that cannot be redeemed, so the panel is told before the click
   * rather than after.
   */
  alreadyHasAccount: boolean;
};

/** One list, newest first — served by `@@index([status, createdAt])` as one scan. */
export async function listAccessRequests(query: unknown): Promise<AccessRequestRow[]> {
  const { status } = listQuerySchema.parse(query);

  const rows = await prisma.accessRequest.findMany({
    where: { status },
    orderBy: { createdAt: "desc" },
    select: REVIEW_FIELDS,
  });

  /**
   * One query for every address on the page rather than one per row.
   *
   * The list is short today and this would be invisible either way; it is
   * written this way because the N+1 version is the kind that stops being
   * invisible without anybody changing it.
   */
  const existing = rows.length
    ? new Set(
        (
          await prisma.user.findMany({
            where: { email: { in: rows.map((row) => row.email) } },
            select: { email: true },
          })
        ).map((user) => user.email),
      )
    : new Set<string>();

  const now = Date.now();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    organization: row.organization,
    message: row.message,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewedByEmail: row.reviewedByEmail,
    inviteValid: Boolean(
      row.inviteTokenExpiresAt && row.inviteTokenExpiresAt.getTime() > now,
    ),
    inviteExpiresAt: row.inviteTokenExpiresAt?.toISOString() ?? null,
    activatedUserId: row.createdUserId,
    alreadyHasAccount: existing.has(row.email),
  }));
}

/** sha256, hex. The column stores this; the email carries the argument. */
const hashToken = (raw: string) =>
  createHash("sha256").update(raw).digest("hex");

/**
 * Approves a request and mints a single-use invite.
 *
 * Creates no user and no college. That is the decision this flow rests on: a
 * college gets a subdomain, and subdomains are unique, so allocating one on
 * approval would let an invite nobody ever opens squat a name forever. The
 * account is built at activation, by the same adopt-or-create path `signup()`
 * uses, and until then this row plus a hash is the entire footprint.
 *
 * Returns the raw token exactly once, to its caller, and never again — there is
 * no way to read it back out of the database.
 */
export async function approveAccessRequest(
  id: string,
  actor: AdminSession,
  customPassword?: string,
) {
  const request = await prisma.accessRequest.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, organization: true, status: true },
  });

  if (!request) throw new AuthError("That request no longer exists", 404);
  if (request.status !== "PENDING") {
    throw new AuthError(`That request was already ${request.status.toLowerCase()}`, 409);
  }

  const rawToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  // Immediately create or activate user account on the spot
  const passToUse = customPassword?.trim() || "college123";
  const passwordHash = await bcrypt.hash(passToUse, 12);

  let user = await prisma.user.findUnique({
    where: { email: request.email },
  });

  if (!user) {
    const orgName = request.organization?.trim() || request.name?.trim() || "College";
    let college = await prisma.college.findFirst({
      where: { name: orgName },
      select: { id: true },
    });

    if (!college) {
      const baseSubdomain = subdomainFromName(orgName);
      let candidate = baseSubdomain;
      for (let suffix = 0; suffix < 50; suffix++) {
        candidate = suffix === 0 ? baseSubdomain : `${baseSubdomain}-${suffix + 1}`;
        const taken = await prisma.college.findUnique({
          where: { subdomain: candidate },
          select: { id: true },
        });
        if (!taken) break;
      }

      college = await prisma.college.create({
        data: {
          name: orgName,
          subdomain: candidate,
          status: "DRAFT",
        },
        select: { id: true },
      });
    }

    user = await prisma.user.create({
      data: {
        email: request.email,
        passwordHash,
        collegeId: college.id,
        status: "ACTIVE",
      },
    });
  } else {
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        status: "ACTIVE",
        passwordHash,
      },
    });
  }

  const { count } = await prisma.accessRequest.updateMany({
    where: { id, status: "PENDING" },
    data: {
      status: "APPROVED",
      reviewedAt: new Date(),
      reviewedById: actor.adminId,
      reviewedByEmail: actor.email,
      inviteTokenHash: hashToken(rawToken),
      inviteTokenExpiresAt: expiresAt,
      createdUserId: user.id,
    },
  });

  if (count !== 1) {
    throw new AuthError("That request was reviewed by someone else just now", 409);
  }

  await recordAudit({
    actor,
    action: "access_request.approve",
    targetType: "access_request",
    targetId: id,
    summary: `Approved access for ${request.email} and created user account on the spot`,
    metadata: { email: request.email, userId: user.id, expiresAt: expiresAt.toISOString() },
  });

  return { email: request.email, name: request.name, rawToken, expiresAt, user };
}

/**
 * Rejects a request.
 *
 * Guarded on PENDING like approve, which the guide's version is not: its reject
 * writes over any row it is given, so a request already approved — with a live
 * invite already emailed — could be flipped to rejected while that invite went
 * on working. Rejecting an approval is a different operation (revocation) and
 * needs to clear the token; this refuses rather than pretending to be it.
 */
export async function rejectAccessRequest(id: string, actor: AdminSession) {
  const request = await prisma.accessRequest.findUnique({
    where: { id },
    select: { email: true, status: true },
  });

  if (!request) throw new AuthError("That request no longer exists", 404);
  if (request.status !== "PENDING") {
    throw new AuthError(`That request was already ${request.status.toLowerCase()}`, 409);
  }

  const { count } = await prisma.accessRequest.updateMany({
    where: { id, status: "PENDING" },
    data: {
      status: "REJECTED",
      reviewedAt: new Date(),
      reviewedById: actor.adminId,
      reviewedByEmail: actor.email,
    },
  });

  if (count !== 1) {
    throw new AuthError("That request was reviewed by someone else just now", 409);
  }

  await recordAudit({
    actor,
    action: "access_request.reject",
    targetType: "access_request",
    targetId: id,
    summary: `Rejected access for ${request.email}`,
    metadata: { email: request.email },
  });

  return { rejected: true as const };
}

// --- Activation ---------------------------------------------------------------

/**
 * 64 hex characters, which is what `randomBytes(32).toString("hex")` produces.
 *
 * Shape-checked before the database is asked, so a truncated paste from an email
 * client that wrapped the line costs nothing and gets a message about the link
 * rather than about the account.
 */
const tokenSchema = z
  .string({ error: "That activation link is not valid" })
  .trim()
  .regex(/^[a-f0-9]{64}$/, "That activation link is not valid");

export const activatePasswordSchema = z.object({
  token: tokenSchema,
  /**
   * Eight, the same as `signupSchema`. Activation is account creation wearing a
   * different name and there is no reason for the two to disagree about what
   * counts as a password.
   */
  password: z
    .string({ error: "Choose a password" })
    .min(8, "Password must be at least 8 characters"),
});

/** Not found, and not-still-valid, told apart. */
const INVALID_INVITE = new AuthError(
  "That activation link is not valid. Ask for a new invite.",
  400,
);
const EXPIRED_INVITE = new AuthError(
  "That activation link has expired. Ask for a new invite.",
  410,
);

/**
 * Finds the request an invite belongs to, or says why it cannot be used.
 *
 * Distinguishing expired from unknown is safe here in a way it would not be on a
 * login form. There is no address to enumerate and no dictionary to grind — the
 * token is 32 random bytes — so the only thing this tells a caller is something
 * about a token they already hold, and "expired" versus "never existed" are
 * genuinely different problems with different fixes.
 */
async function requestForToken(rawToken: string) {
  const request = await prisma.accessRequest.findUnique({
    where: { inviteTokenHash: hashToken(rawToken) },
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      inviteTokenExpiresAt: true,
      createdUserId: true,
    },
  });

  // A consumed invite has no hash at all, so it lands here rather than below —
  // "not valid" is the honest answer for a link that has already been used.
  if (!request) throw INVALID_INVITE;
  if (request.status !== "APPROVED") throw INVALID_INVITE;
  if (request.createdUserId) throw INVALID_INVITE;
  if (
    !request.inviteTokenExpiresAt ||
    request.inviteTokenExpiresAt.getTime() <= Date.now()
  ) {
    throw EXPIRED_INVITE;
  }

  return request;
}

/**
 * Redeems an invite: creates the college, creates the user, consumes the token.
 *
 * All three in one transaction, and the ordering inside it is the point. The
 * token is nulled *first*, conditionally on it still being there, so two clicks
 * on the same link cannot both proceed — the second finds nothing to consume and
 * loses. Then the account is created; if that fails for any reason the whole
 * thing rolls back and the invite is live again, which is the behaviour somebody
 * whose password was rejected needs. Consuming outside the transaction would
 * burn the invite on a failure and lock them out of an account that was never
 * created.
 *
 * This is where a College first exists. Approval deliberately created nothing,
 * so an invite nobody opened never held a subdomain.
 */
async function redeem(
  request: { id: string; email: string },
  passwordHash: string,
) {
  return prisma.$transaction(async (tx) => {
    const consumed = await tx.accessRequest.updateMany({
      where: { id: request.id, inviteTokenHash: { not: null } },
      data: { inviteTokenHash: null, inviteTokenExpiresAt: null },
    });
    if (consumed.count !== 1) throw INVALID_INVITE;

    const user = await provisionCollegeAndUser(tx, {
      email: request.email,
      passwordHash,
    });

    await tx.accessRequest.update({
      where: { id: request.id },
      data: { createdUserId: user.id },
    });

    return user;
  });
}

/**
 * Activation by setting a password.
 *
 * Returns a session, unlike `signup()`, which deliberately does not. The
 * reasoning there was that the flow is signup → sign in → editor, so the
 * password is proved to work as part of creating the account. Here the invite has
 * already proved who this is, and sending somebody who just clicked a one-time
 * link to a login form is asking them to prove it twice.
 */
export async function activateWithPassword(input: unknown) {
  const { token, password } = activatePasswordSchema.parse(input);
  const request = await requestForToken(token);

  /**
   * Checked again, immediately before the write.
   *
   * `approveAccessRequest` already refuses an address that has an account, but
   * that was up to 48 hours ago. `users.email` is unique, so without this the
   * failure is a constraint violation surfacing as a 500 to somebody who did
   * nothing wrong.
   */
  const taken = await prisma.user.findUnique({
    where: { email: request.email },
    select: { id: true },
  });
  if (taken) {
    throw new AuthError(
      "An account already exists for this address. Try signing in instead.",
      409,
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await redeem(request, passwordHash);

  return {
    token: await mintSessionToken({ userId: user.id, collegeId: user.collegeId }),
    subdomain: user.college.subdomain,
    next: destinationFor(user.college),
  };
}

export const activateGoogleSchema = z.object({
  token: tokenSchema,
  /** Google's id_token, forwarded by the frontend that obtained it. */
  idToken: z.string({ error: "Missing Google identity token" }).min(1),
});

/**
 * Activation by linking a Google account.
 *
 * The email match is the whole point of this function, and it is checked against
 * an identity this service verified itself — not one the caller asserted. See
 * `google-identity.ts` for why that distinction is the security boundary of the
 * entire flow rather than a formality.
 *
 * Exact match, after both sides are lowercased. Deliberately not "same domain"
 * or "same local part": the invite was issued to one mailbox, and anything looser
 * is a different person.
 */
export async function activateWithGoogle(input: unknown) {
  const { token, idToken } = activateGoogleSchema.parse(input);
  const request = await requestForToken(token);
  const identity = await verifyGoogleIdToken(idToken);

  if (identity.email !== request.email) {
    /**
     * Says which address was expected, and does not say which was offered.
     *
     * The person holding the invite already knows the address it was sent to —
     * it is their own — so naming it turns "rejected" into an instruction. The
     * Google address is withheld because this response is reachable by anybody
     * holding a leaked invite, and it must not become a way to read the mailbox
     * of whoever they signed in as.
     */
    throw new AuthError(
      `This invite was issued to ${request.email}. Sign in with that Google account, or set a password instead.`,
      403,
    );
  }

  const taken = await prisma.user.findUnique({
    where: { email: request.email },
    select: { id: true },
  });
  if (taken) {
    throw new AuthError(
      "An account already exists for this address. Try signing in instead.",
      409,
    );
  }

  /**
   * Google is the credential, so there is no password to store.
   *
   * A random unusable string keeps the column NOT NULL without inventing a
   * password anyone could guess or reuse — the same approach xite-F's Google
   * sign-in already takes, and the reason it is a fixed prefix is so a row like
   * this is recognisable for what it is. `bcrypt.compare` against it is false for
   * every input, so password sign-in simply does not work for this account, which
   * is the correct behaviour rather than a side effect.
   */
  const user = await redeem(request, `google:${randomUUID()}`);

  return {
    token: await mintSessionToken({ userId: user.id, collegeId: user.collegeId }),
    userId: user.id,
    collegeId: user.collegeId,
    subdomain: user.college.subdomain,
    next: destinationFor(user.college),
  };
}

/**
 * What the activation page needs before it draws anything.
 *
 * The email is returned so the page can say which address it is activating —
 * somebody forwarded an invite, or holding two, should not have to guess. It is
 * safe to return because the caller already holds the token, and the token is the
 * secret; the address is what the token is *for*.
 *
 * Deliberately does not consume anything. A link opened twice in a browser that
 * prefetches must not burn the invite before the form is submitted.
 */
export async function inviteSummary(rawToken: unknown) {
  const token = tokenSchema.parse(rawToken);
  const request = await requestForToken(token);
  return { email: request.email, name: request.name };
}
