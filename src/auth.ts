import { jwtVerify } from "jose";

import { prisma } from "@/db";

const COOKIE_NAME = "college_session";

export type Session = { userId: string; collegeId: string };

function secretKey() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be set and at least 32 characters");
  }
  return new TextEncoder().encode(secret);
}

/**
 * Open-access mode, mirroring the frontend exactly.
 *
 * The two services must agree on who the caller is, or the editor would save
 * happily through one and get 401s from the other.
 */
const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";

async function openAccessCollege() {
  // isDemo excluded: the seeded showcases are older than any real college, so
  // "oldest" alone would hand a visitor a demo site to edit.
  const existing = await prisma.college.findFirst({
    where: { isDemo: false },
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing;

  return prisma.college.upsert({
    where: { subdomain: process.env.OPEN_ACCESS_SUBDOMAIN || "main" },
    update: {},
    create: {
      name: process.env.OPEN_ACCESS_COLLEGE_NAME || "My College",
      subdomain: process.env.OPEN_ACCESS_SUBDOMAIN || "main",
      status: "DRAFT",
    },
  });
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
  if (AUTH_DISABLED) {
    const college = await openAccessCollege();
    return { userId: `open-access:${college.id}`, collegeId: college.id };
  }

  const token = readCookie(cookieHeader, COOKIE_NAME);
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secretKey());
    const { userId, collegeId } = payload as Record<string, unknown>;
    if (typeof userId !== "string" || typeof collegeId !== "string") return null;
    return { userId, collegeId };
  } catch {
    // Expired or tampered — signed out, not an error worth surfacing.
    return null;
  }
}
