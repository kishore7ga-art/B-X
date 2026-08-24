/**
 * Creates and manages Super Admin accounts, from a terminal only.
 *
 * There is deliberately no registration endpoint. A panel that can delete every
 * college on the platform should not have a public door, however well guarded —
 * the only way in is for somebody with database access to put an account there.
 *
 * Usage:
 *   node scripts/admin.mjs list
 *   node scripts/admin.mjs create   <email> <password>
 *   node scripts/admin.mjs password <email> <password>   # change it
 *   node scripts/admin.mjs enrol    <email>              # turn TOTP on
 *   node scripts/admin.mjs unenrol  <email>              # turn TOTP off
 *
 * This talks to MongoDB directly rather than importing the app.
 *
 * It used to open a Postgres pool from `src/lib/db-pool.ts` and run `UPDATE
 * admin_users SET password_hash = ...`, against a service that has been on
 * Mongoose for as long as `admin_users.model.ts` has existed. Neither the file
 * nor the table was there, so the command exited on an unresolved import before
 * it read its arguments — which meant the one documented way to recover a Super
 * Admin password did not run at all. That was survivable only while `adminLogin`
 * accepted a hardcoded literal; now that it does not, this script *is* the
 * recovery path, so it deliberately depends on nothing but the driver, the
 * hasher and the URI. It works against an unbuilt checkout and cannot be broken
 * by a change to the app's module layout.
 *
 * The schema below is a deliberate copy of `admin_users.model.ts`, narrowed to
 * the fields this tool touches. Same model name, so Mongoose derives the same
 * collection; if that model is renamed, rename it here too.
 */
import "dotenv/config";

import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import dns from "node:dns";
import * as OTPAuth from "otpauth";

/**
 * Prefer A records over AAAA, which is the Node 17 change that breaks Atlas SRV
 * lookups on hosts advertising IPv6 without a route to it. Ordering only — it
 * does not change who answers.
 *
 * `dns.setServers(["8.8.8.8", "1.1.1.1"])` used to sit beside this. It is
 * process-wide, so it replaces the resolver for everything this process looks
 * up, and on a machine using a corporate or split-horizon resolver it makes the
 * cluster *less* reachable rather than more. `src/config/db.ts` moved it behind
 * `DNS_SERVERS` for the same reason; this is the recovery tool, so it follows.
 *
 *   DNS_SERVERS=8.8.8.8,1.1.1.1 node scripts/admin.mjs list
 */
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {}

const dnsServers = (process.env.DNS_SERVERS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

if (dnsServers.length > 0) {
  try {
    dns.setServers(dnsServers);
  } catch {}
}

const AdminUser = mongoose.model(
  "AdminUser",
  new mongoose.Schema(
    {
      email: { type: String, required: true, unique: true, lowercase: true, trim: true },
      passwordHash: { type: String, required: true },
      totpSecret: { type: String, default: null },
      role: { type: String, default: "SUPER_ADMIN" },
    },
    { timestamps: true },
  ),
);

/**
 * Passwords this repository has published, and a length floor.
 *
 * The same list `admin-bootstrap.ts` refuses, for the same reason: a value that
 * has appeared in a public file is burned. It is repeated rather than imported
 * because importing it would put a TypeScript module back in the dependency
 * chain of the tool whose whole point is not to have one.
 */
const PUBLISHED_PASSWORDS = [
  "2008",
  "changeme",
  "change-me",
  "password",
  "admin",
  "replace-with-secure-admin-password",
  "college123",
  "greenfield123",
];

const [command, ...args] = process.argv.slice(2);

const USAGE =
  "\n  node scripts/admin.mjs list\n" +
  "  node scripts/admin.mjs create   <email> <password>\n" +
  "  node scripts/admin.mjs password <email> <password>\n" +
  "  node scripts/admin.mjs enrol    <email>\n" +
  "  node scripts/admin.mjs unenrol  <email>\n";

const COMMANDS = ["list", "create", "password", "enrol", "enroll", "unenrol", "unenroll"];

async function done(code = 0) {
  await mongoose.disconnect().catch(() => {});
  process.exit(code);
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  return done(1);
}

/**
 * A published password is refused outright; a short one can be forced.
 *
 * The two are not the same mistake. Twelve characters is a judgement about
 * strength that the operator is entitled to overrule — they already have
 * database access — so `--force` exists and has to be typed, which makes a weak
 * admin password a decision somebody made rather than one that happened. A
 * string printed in this repository's own documentation is not weak, it is
 * *known*, and there is no situation where setting it is the right call.
 */
function rejectPassword(password, forced) {
  if (PUBLISHED_PASSWORDS.includes(password.trim().toLowerCase())) {
    return (
      "That password appears in this repository. It is public, and --force " +
      "will not take it either.\n  Generate one: openssl rand -base64 24"
    );
  }
  if (password.length < 12 && !forced) {
    return (
      "Password must be at least 12 characters.\n" +
      "  Add --force to override — this account can delete every college."
    );
  }
  return null;
}

async function connect() {
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;
  if (!uri) {
    console.error(
      "\n  Neither MONGODB_URI nor DATABASE_URL is set.\n" +
        "  Copy the value from the backend service's environment in Dokploy,\n" +
        "  or put it in a .env file beside package.json.\n",
    );
    process.exit(1);
  }
  mongoose.set("strictQuery", false);
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  } catch (error) {
    /**
     * A recovery tool that answers a wrong URI with a driver stack trace is
     * asking the person least able to read it. The three things that are ever
     * wrong here are the credentials, the IP allowlist and the host, so say so.
     */
    console.error(`\n  Could not reach the database: ${error.message}\n`);
    console.error("  Usually one of:");
    console.error("    - the URI's username/password is stale — copy it from Dokploy again");
    console.error("    - this machine's IP is not on the Atlas access list");
    console.error("    - MONGODB_URI points at a different cluster than the backend does\n");
    process.exit(1);
  }
}

if (!command || !COMMANDS.includes(command)) {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}

await connect();

const positional = args.filter((a) => !a.startsWith("--"));
const forced = args.includes("--force");
const email = positional[0]?.trim().toLowerCase() ?? "";

if (command === "list") {
  const rows = await AdminUser.find({}, "email totpSecret role createdAt").sort({ createdAt: 1 });
  if (!rows.length) {
    console.log("\n  No admin accounts.\n");
  } else {
    console.log("");
    for (const row of rows) {
      console.log(
        `  ${row.email.padEnd(34)} totp=${row.totpSecret ? "on " : "off"}  ` +
          `role=${row.role ?? "SUPER_ADMIN"}  created: ${row.createdAt?.toISOString() ?? "unknown"}`,
      );
    }
    console.log("");
  }
  await done();
}

if (command === "create") {
  const password = positional[1];
  if (!email || !password) await fail("Usage: create <email> <password>");

  const problem = rejectPassword(password, forced);
  if (problem) await fail(problem);

  if (await AdminUser.findOne({ email })) {
    await fail(`${email} already exists. Use \`password ${email} <new>\` to change it.`);
  }

  await AdminUser.create({
    email,
    passwordHash: await bcrypt.hash(password, 12),
    role: "SUPER_ADMIN",
  });

  console.log(`\n  Created ${email}.`);
  console.log("  Sign in at the admin panel with this email and password.");
  console.log(`  Turn on a second factor:  node scripts/admin.mjs enrol ${email}\n`);
  await done();
}

if (command === "password") {
  const password = positional[1];
  if (!email || !password) await fail("Usage: password <email> <new password>");

  const problem = rejectPassword(password, forced);
  if (problem) await fail(problem);

  const admin = await AdminUser.findOne({ email });
  if (!admin) await fail(`No admin account for ${email}. Run \`list\` to see which exist.`);

  admin.passwordHash = await bcrypt.hash(password, 12);
  await admin.save();

  console.log(`\n  Password changed for ${email}.`);
  if (admin.totpSecret) {
    console.log("  This account has TOTP on — sign-in still asks for the 6-digit code.");
  }
  /**
   * ADMIN_BOOTSTRAP_PASSWORD outranks whatever is set here.
   *
   * While it is set, `bootstrapAdmin` compares it against the stored hash on
   * every boot and resets the account when they differ — so a password changed
   * here is reverted by the next deploy, which looks exactly like the change
   * never saved.
   */
  console.log(
    "\n  If ADMIN_BOOTSTRAP_PASSWORD is still set on the backend service,\n" +
      "  remove it — every deploy re-applies it and undoes this change.\n",
  );
  await done();
}

if (command === "enrol" || command === "enroll") {
  if (!email) await fail("Usage: enrol <email>");

  const admin = await AdminUser.findOne({ email });
  if (!admin) await fail(`No admin account for ${email}.`);

  const secret = new OTPAuth.Secret({ size: 20 });
  const totp = new OTPAuth.TOTP({
    issuer: "XITE",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });

  admin.totpSecret = secret.base32;
  await admin.save();

  console.log(`\n  TOTP enabled for ${email}.`);
  console.log("  Add it to your authenticator app, either way:\n");
  console.log(`    Secret : ${secret.base32}`);
  console.log(`    URL    : ${totp.toString()}\n`);
  console.log("  A 6-digit code is REQUIRED from now on — there is no password");
  console.log("  that skips it. If you lose the authenticator, run:");
  console.log(`      node scripts/admin.mjs unenrol ${email}\n`);
  await done();
}

if (command === "unenrol" || command === "unenroll") {
  if (!email) await fail("Usage: unenrol <email>");

  const admin = await AdminUser.findOne({ email });
  if (!admin) await fail(`No admin account for ${email}.`);

  if (!admin.totpSecret) {
    console.log(`\n  ${email} does not have TOTP on. Nothing to do.\n`);
    await done();
  }

  admin.totpSecret = null;
  await admin.save();

  /**
   * This command exists because the second factor has no bypass.
   *
   * `adminLogin` treats an enrolled account as requiring a code, full stop —
   * which is the point of it. The cost of that is a lost authenticator locking
   * the account forever, and the honest answer to that is a documented way out
   * that requires database access, not a weaker check in the login path.
   */
  console.log(`\n  TOTP turned off for ${email}. The password alone signs in now.`);
  console.log(`  Turn it back on:  node scripts/admin.mjs enrol ${email}\n`);
  await done();
}
