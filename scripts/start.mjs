/**
 * Production entrypoint: apply migrations, seed reference data, then serve.
 *
 * In a split deployment this container is the only one that touches the
 * schema, so this is the single place migrations run. Both steps are retried
 * and non-fatal: a slow database should delay the first boot, not crash-loop
 * the API behind a 502 with nothing in the logs to explain it.
 */
import { spawn } from "node:child_process";

const MAX_ATTEMPTS = Number(process.env.MIGRATE_RETRIES ?? 5);
const FAIL_FAST = process.env.MIGRATE_FAIL_FAST === "true";

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: true,
      env: { ...process.env, ...env },
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the URL from POSTGRES_PASSWORD when it arrives empty.
 *
 * Compose's default nests one interpolation inside another's fallback, which
 * not every version expands. Same inputs, same URL, no interpolation.
 */
if (!process.env.DATABASE_URL && process.env.POSTGRES_PASSWORD) {
  process.env.DATABASE_URL =
    `postgresql://collegeadmin:${encodeURIComponent(process.env.POSTGRES_PASSWORD)}` +
    "@db:5432/college_saas?schema=public";
  console.log("[start] DATABASE_URL was empty; built it from POSTGRES_PASSWORD.");
}

if (!process.env.DATABASE_URL) {
  console.error(
    "[start] Neither DATABASE_URL nor POSTGRES_PASSWORD is set, so there is " +
      "nothing to connect to. The API will start anyway and /api/health will " +
      "say so, which beats a 502 that says nothing.",
  );
}

let migrated = false;
for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log(`[start] applying migrations (attempt ${attempt}/${MAX_ATTEMPTS})`);
  if ((await run("npx", ["prisma", "migrate", "deploy"])) === 0) {
    migrated = true;
    break;
  }
  if (attempt < MAX_ATTEMPTS) {
    const delay = Math.min(2 ** attempt, 30);
    console.warn(`[start] migration failed, retrying in ${delay}s`);
    await sleep(delay * 1000);
  }
}

if (!migrated) {
  console.error("[start] migrations did not apply after all retries.");
  if (FAIL_FAST) process.exit(1);
  console.error("[start] starting the API anyway so the error is visible.");
}

if (migrated && process.env.SEED_ON_START !== "false") {
  console.log("[start] seeding reference data (templates, variants, themes)");
  if ((await run("npx", ["prisma", "db", "seed"], { SEED_DEMO_COLLEGE: "false" })) !== 0) {
    console.error("[start] seeding failed. The API will start anyway.");
  }
}

process.exit(await run("npx", ["tsx", "src/server.ts"]));
