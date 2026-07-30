/**
 * Creates and manages Super Admin accounts, from a terminal only.
 *
 * There is deliberately no registration endpoint. A panel that can delete every
 * college on the platform should not have a public door, however well guarded —
 * the only way in is for somebody with database access to put an account there.
 *
 * Usage:
 *   node scripts/admin.mjs create   <email> <password>
 *   node scripts/admin.mjs password <email> <password>   # change it
 *   node scripts/admin.mjs enrol    <email>   # turn on TOTP, prints the secret
 *   node scripts/admin.mjs list
 *
 * The password is the whole credential — the sign-in form does not ask for the
 * email — so it is set here, from a terminal, and never lives in the repo.
 */
import "dotenv/config";

import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import * as OTPAuth from "otpauth";

import { createPool } from "../src/lib/db-pool.ts";

const [command, ...args] = process.argv.slice(2);
const pool = createPool();

const done = async (code = 0) => {
  await pool.end();
  process.exit(code);
};

if (
  !command ||
  !["create", "password", "enrol", "enroll", "list"].includes(command)
) {
  console.log(
    "\n  node scripts/admin.mjs create   <email> <password>\n" +
      "  node scripts/admin.mjs password <email> <password>\n" +
      "  node scripts/admin.mjs enrol    <email>\n" +
      "  node scripts/admin.mjs list\n",
  );
  await done(1);
}

if (command === "list") {
  const { rows } = await pool.query(
    `SELECT email, totp_secret IS NOT NULL AS totp, last_login_at, created_at
       FROM admin_users ORDER BY created_at`,
  );
  if (!rows.length) console.log("\n  No admin accounts.\n");
  else {
    console.log("");
    for (const row of rows) {
      console.log(
        `  ${row.email.padEnd(32)} totp=${row.totp ? "on " : "off"}  ` +
          `last login: ${row.last_login_at?.toISOString() ?? "never"}`,
      );
    }
    console.log("");
  }
  await done();
}

if (command === "create") {
  const [email, password] = args.filter((a) => a !== "--force");
  if (!email || !password) {
    console.error("\n  Usage: create <email> <password>\n");
    await done(1);
  }
  /**
   * Twelve, four more than a college owner gets, because this account can
   * delete every college on the platform.
   *
   * `--force` exists because the operator running this has database access
   * already and is entitled to overrule a default — but it has to be typed,
   * so a weak admin password is a decision somebody made rather than one that
   * happened. It says so, loudly, and the floor stays where it is for
   * everything created without it.
   */
  const forced = args.includes("--force");
  if (password.length < 12 && !forced) {
    console.error(
      "\n  Password must be at least 12 characters.\n" +
        "  Add --force to override — this account can delete every college.\n",
    );
    await done(1);
  }

  const normalised = email.trim().toLowerCase();
  const existing = await pool.query(
    "SELECT id FROM admin_users WHERE email = $1",
    [normalised],
  );
  if (existing.rows.length) {
    console.error(`\n  ${normalised} already exists. Use enrol, or delete it first.\n`);
    await done(1);
  }

  await pool.query(
    `INSERT INTO admin_users (id, email, password_hash, created_at)
     VALUES ($1, $2, $3, now())`,
    [randomUUID(), normalised, await bcrypt.hash(password, 12)],
  );

  console.log(`\n  Created ${normalised}.`);
  console.log("  Sign in at /admin — password only until you run:");
  console.log(`      node scripts/admin.mjs enrol ${normalised}\n`);
  await done();
}

if (command === "password") {
  const [email, password] = args.filter((a) => a !== "--force");
  if (!email || !password) {
    console.error("\n  Usage: password <email> <new password>\n");
    await done(1);
  }

  // Same floor and the same escape hatch as `create`. Changing a password is
  // not a weaker act than setting one, so it does not get a weaker rule.
  if (password.length < 12 && !args.includes("--force")) {
    console.error(
      "\n  Password must be at least 12 characters.\n" +
        "  Add --force to override — this account can delete every college.\n",
    );
    await done(1);
  }

  const normalised = email.trim().toLowerCase();
  const updated = await pool.query(
    "UPDATE admin_users SET password_hash = $1 WHERE email = $2",
    [await bcrypt.hash(password, 12), normalised],
  );

  if (!updated.rowCount) {
    console.error(`\n  No admin account for ${normalised}.\n`);
    await done(1);
  }

  console.log(`\n  Password changed for ${normalised}.`);
  console.log("  Sign-in asks for the password only — the email is the");
  console.log("  account's identity, not a credential to type.\n");
  await done();
}

if (command === "enrol" || command === "enroll") {
  const [email] = args;
  if (!email) {
    console.error("\n  Usage: enrol <email>\n");
    await done(1);
  }

  const normalised = email.trim().toLowerCase();
  const found = await pool.query(
    "SELECT id FROM admin_users WHERE email = $1",
    [normalised],
  );
  if (!found.rows.length) {
    console.error(`\n  No admin account for ${normalised}.\n`);
    await done(1);
  }

  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer: "XITE",
    label: normalised,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });

  await pool.query("UPDATE admin_users SET totp_secret = $1 WHERE email = $2", [
    secret.base32,
    normalised,
  ]);

  console.log(`\n  TOTP enabled for ${normalised}.`);
  console.log("  Add it to your authenticator app, either way:\n");
  console.log(`    Secret : ${secret.base32}`);
  console.log(`    URL    : ${totp.toString()}\n`);
  console.log("  A 6-digit code is now REQUIRED to sign in. Losing the");
  console.log("  authenticator means clearing totp_secret in the database.\n");
  await done();
}
