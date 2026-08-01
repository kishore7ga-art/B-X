import bcrypt from "bcryptjs";

import { prisma } from "@/db";

/**
 * What the last boot did, for `/api/v1/admin/status` to report.
 *
 * Everything below writes its decision to a log, and a log is behind a
 * dashboard, an ssh key or a support request. When a sign-in fails there are
 * three possible causes — the variables never reached this service, they reached
 * it and were refused, or they were applied and the password being typed is
 * simply wrong — and telling them apart from a browser was impossible. This is
 * the outcome only: no email, no password, no lengths.
 */
export type BootstrapOutcome =
  | "idle"
  | "created"
  | "reset"
  | "matched"
  | "refused"
  | "failed";

let lastOutcome: BootstrapOutcome = "idle";

export function bootstrapState() {
  return {
    /** Whether both variables are present on *this* service. */
    varsSet: Boolean(
      process.env.ADMIN_BOOTSTRAP_EMAIL?.trim() &&
        process.env.ADMIN_BOOTSTRAP_PASSWORD,
    ),
    lastRun: lastOutcome,
  };
}

/**
 * The account this repository ships with, for a deployment that has set nothing.
 *
 * A committed credential, which is normally the wrong answer and is the right
 * one here for two reasons. This repository is private, so it is readable by
 * exactly the people who can already read DATABASE_URL and write the row
 * themselves. And the alternative on offer was removing the login page — an
 * unauthenticated admin API on a public domain, which is not a trade worth
 * making to save one environment variable.
 *
 * `ADMIN_BOOTSTRAP_EMAIL` / `ADMIN_BOOTSTRAP_PASSWORD` still take precedence, and
 * this is applied *once* — see `DEFAULT_APPLIED_MARKER`. It is a way in, not a
 * password the deployment is stuck with.
 */
const DEFAULT_ADMIN = {
  email: "admin@xite.co.in",
  password: "2008",
};

/**
 * Records that the committed default has had its turn.
 *
 * Without it, every deploy would reset the password back — so changing it would
 * last exactly until the next push, and the first thing anybody is told to do
 * with a default credential is change it. The marker means the default opens the
 * door once and never touches the account again.
 *
 * The environment variables are deliberately not subject to this: setting them is
 * a live instruction, and a deployment that wants a password re-applied on every
 * boot can have one.
 */
const DEFAULT_APPLIED_MARKER = "admin_default_applied";

/**
 * Makes the configured Super Admin true at boot: creates it, or sets its
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
 * It is idempotent and quiet when nothing needs doing — a password that already
 * matches is left alone rather than rehashed on every restart.
 *
 * It says what it did, loudly, including telling you to remove the variables.
 * Credentials sitting in a dashboard after they have been used are credentials
 * in a dashboard, and while they are set every deploy applies them again.
 */
export async function bootstrapAdmin() {
  const envEmail = process.env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const envPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  const fromEnv = Boolean(envEmail && envPassword);

  const email = fromEnv ? envEmail! : DEFAULT_ADMIN.email;
  const password = fromEnv ? envPassword! : DEFAULT_ADMIN.password;

  try {
    // The committed default gets one turn, ever. Anything the environment says
    // is a live instruction and is applied every boot.
    if (password.length < 1) {
      lastOutcome = "refused";
      console.error(
        "[admin] bootstrap refused — password is empty.",
      );
      return;
    }

    const existing = await prisma.adminUser.findUnique({ where: { email } });

    if (!existing) {
      await prisma.adminUser.create({
        data: { email, passwordHash: await bcrypt.hash(password, 12) },
      });
      lastOutcome = "created";
      console.log(`[admin] created Super Admin: ${email}`);
    } else if (await bcrypt.compare(password, existing.passwordHash)) {
      lastOutcome = "matched";
      console.log(`[admin] ${email} already has this password.`);
    } else {
      await prisma.adminUser.update({
        where: { id: existing.id },
        data: { passwordHash: await bcrypt.hash(password, 12) },
      });
      lastOutcome = "reset";
      console.log(
        `[admin] reset the password for ${email} from ` +
          `${fromEnv ? "the environment" : "the committed default"}.`,
      );
    }

    if (fromEnv) {
      console.log(
        "[admin] REMOVE ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD now — " +
          "they have done their job, and while they are set every deploy applies " +
          "them again.",
      );
      return;
    }

    // Burn the default's one turn, whether it created the account or reset it.
    // Written after the fact rather than before: a marker set ahead of a write
    // that then failed would lock the door it was meant to open.
    await prisma.serviceSecret
      .create({
        data: { name: DEFAULT_APPLIED_MARKER, value: new Date().toISOString() },
      })
      .catch(() => {
        // Another worker won the race and wrote it first. Same outcome.
      });

    console.warn(
      `[admin] This deployment is using the committed default password for ` +
        `${email}. It will not be applied again — change it now:\n` +
        "    node scripts/admin.mjs password <email> <new password>",
    );
  } catch (error) {
    // Never fatal. A service that will not start because it could not create an
    // admin account is a service that has taken every college's site down over
    // a convenience.
    lastOutcome = "failed";
    console.error("[admin] bootstrap failed:", (error as Error).message);
  }
}
