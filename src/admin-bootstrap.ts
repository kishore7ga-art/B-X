import bcrypt from "bcryptjs";

import { prisma } from "@/db";

/**
 * Makes the environment's Super Admin true at boot: creates it, or sets its
 * password to the one given.
 *
 * The CLI is the right way to manage an admin account, and it stays the right
 * way — but it needs a shell on the box, and a Dokploy deployment is a
 * dashboard with environment variables long before it is a terminal somebody
 * is comfortable in. Without this the panel ships complete and unreachable,
 * which is how it went out.
 *
 * It used to refuse the moment any admin existed, which read as safe and left
 * one hole it could not climb out of: a deployment with an account whose
 * password nobody knows. That is not a hypothetical — a bootstrapped account and
 * a password set later on a different database is exactly it, and the login says
 * "Incorrect password or code" with no way in from the dashboard. So it now
 * resets rather than skips.
 *
 * That is not a new privilege. Anybody who can set these variables can already
 * set ADMIN_SESSION_SECRET and sign their own session, or read DATABASE_URL and
 * write the row directly. What keeps it honest:
 *
 * Both variables have to be set deliberately. No default email, no default
 * password, and an unconfigured deployment does nothing at all.
 *
 * It is idempotent and quiet when nothing needs doing — a password that already
 * matches is left alone rather than rehashed on every restart.
 *
 * It says what it did, loudly, including telling you to remove the variables.
 * Credentials sitting in a dashboard after they have been used are credentials
 * in a dashboard, and now they are ones that would be re-applied on every deploy.
 */
export async function bootstrapAdmin() {
  const email = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  if (!email || !password) return;

  try {
    if (password.length < 8) {
      console.error(
        "[admin] bootstrap refused — ADMIN_BOOTSTRAP_PASSWORD is under 8 characters.",
      );
      return;
    }

    const existing = await prisma.adminUser.findUnique({ where: { email } });

    if (!existing) {
      await prisma.adminUser.create({
        data: { email, passwordHash: await bcrypt.hash(password, 12) },
      });
      console.log(`[admin] created Super Admin: ${email}`);
    } else if (await bcrypt.compare(password, existing.passwordHash)) {
      // Already what the environment asks for. Nothing to say beyond the fact
      // that the variables have outlived their purpose.
      console.log(
        `[admin] ${email} already has this password. ` +
          "Remove ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD.",
      );
      return;
    } else {
      await prisma.adminUser.update({
        where: { id: existing.id },
        data: { passwordHash: await bcrypt.hash(password, 12) },
      });
      console.log(`[admin] reset the password for ${email} from the environment.`);
    }

    console.log(
      "[admin] REMOVE ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD now — " +
        "they have done their job, and while they are set every deploy applies " +
        "them again.",
    );
  } catch (error) {
    // Never fatal. A service that will not start because it could not create an
    // admin account is a service that has taken every college's site down over
    // a convenience.
    console.error("[admin] bootstrap failed:", (error as Error).message);
  }
}
