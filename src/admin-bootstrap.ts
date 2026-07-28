import bcrypt from "bcryptjs";

import { prisma } from "@/db";

/**
 * Creates the very first Super Admin from the environment, once.
 *
 * The CLI is the right way to make an admin account, and it stays the right
 * way — but it needs a shell on the box, and a Dokploy deployment is a
 * dashboard with environment variables long before it is a terminal somebody
 * is comfortable in. Without this the panel ships complete and unreachable,
 * which is how it went out.
 *
 * Three things keep it from becoming a back door:
 *
 * It only ever runs against an empty table. The moment one admin exists this
 * does nothing, so it cannot add a second account, cannot reset a password,
 * and cannot be used to get back in after being locked out.
 *
 * It needs both variables set deliberately. There is no default email and no
 * default password — an unconfigured deployment creates nothing.
 *
 * It says what it did, at boot, in the log, including telling you to remove
 * the variables. Credentials sitting in a dashboard after they have been used
 * are credentials in a dashboard.
 */
export async function bootstrapAdmin() {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  if (!email || !password) return;

  try {
    const existing = await prisma.adminUser.count();
    if (existing > 0) {
      console.log(
        `[admin] bootstrap skipped — ${existing} admin account(s) already exist. ` +
          "Remove ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD.",
      );
      return;
    }

    if (password.length < 8) {
      console.error(
        "[admin] bootstrap refused — ADMIN_BOOTSTRAP_PASSWORD is under 8 characters.",
      );
      return;
    }

    await prisma.adminUser.create({
      data: { email, passwordHash: await bcrypt.hash(password, 12) },
    });

    console.log(`[admin] created first Super Admin: ${email}`);
    console.log(
      "[admin] REMOVE ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD now — " +
        "they have done their job and are a password sitting in a dashboard.",
    );
  } catch (error) {
    // Never fatal. A service that will not start because it could not create an
    // admin account is a service that has taken every college's site down over
    // a convenience.
    console.error("[admin] bootstrap failed:", (error as Error).message);
  }
}
