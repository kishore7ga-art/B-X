/**
 * Fails the build when a file shared with the other repo has drifted.
 *
 * Twelve files exist in both xite-F and xite-B as manual copies. That has caused
 * two production outages: a schema change without the matching migration in the
 * other repo, and a seed left behind that would have re-baked a demo college's
 * name into every template. Both looked unrelated to the change that caused
 * them, which is what made them expensive.
 *
 * This is a stopgap, not the fix — the fix is one shared package and no copies.
 * Until then a checksum mismatch should stop a build rather than reach
 * production, because the failure mode is silent by nature.
 *
 * Updating a shared file legitimately: change it in both repos, then run
 *   node scripts/check-shared-files.mjs --update
 * and commit the regenerated manifest in both.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const SHARED = [
  "src/lib/college-types.ts",
  "src/lib/json-stable.ts",
  "src/lib/auth/cookie-domain.ts",
  "src/lib/api-contract.ts",
  // How a section's category is decided. Four disagreeing copies of this rule
  // is what let a template be a `navbar` to one screen and a `custom` to
  // another — the reason a section could swap into a variant of a different
  // kind, or find no variants at all.
  "src/lib/sections/categories.ts",
];

/**
 * Files shared with xite-admin rather than with each other.
 *
 * `section-runtime.ts` is the rendering environment every section is authored
 * against — the Admin previews a section in an iframe built from it, and the
 * editor and the published site build their canvas from it. Three surfaces
 * agreeing "by construction" only holds while the file is actually identical,
 * and nothing checked. It is the one file where drift is invisible until a
 * section renders differently in the studio than it does live.
 */
const SHARED_WITH_ADMIN = ["src/lib/section-runtime.ts"];

const MANIFEST = "shared-files.lock.json";

/** Line endings differ between checkouts on Windows; content does not. */
const digest = (path) =>
  createHash("sha256")
    .update(readFileSync(path, "utf8").replace(/\r\n/g, "\n"))
    .digest("hex")
    .slice(0, 16);

const current = Object.fromEntries(
  [...SHARED, ...SHARED_WITH_ADMIN].filter(existsSync).map((path) => [path, digest(path)]),
);

if (process.argv.includes("--update")) {
  writeFileSync(MANIFEST, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`[shared] manifest updated — commit ${MANIFEST} in BOTH repos`);
  process.exit(0);
}

if (!existsSync(MANIFEST)) {
  console.error(
    `[shared] ${MANIFEST} is missing. Run with --update once, in both repos.`,
  );
  process.exit(1);
}

const expected = JSON.parse(readFileSync(MANIFEST, "utf8"));
const drifted = Object.keys({ ...expected, ...current }).filter(
  (path) => expected[path] !== current[path],
);

if (drifted.length) {
  console.error("\n[shared] These files no longer match the other repo:\n");
  for (const path of drifted) {
    const was = expected[path] ?? "(absent)";
    const now = current[path] ?? "(absent)";
    console.error(`  ${path}\n    manifest ${was} · here ${now}`);
  }
  console.error(
    "\n  Copy the change into the other repo, then run:\n" +
      "    node scripts/check-shared-files.mjs --update\n" +
      "  and commit the manifest in both.\n",
  );
  process.exit(1);
}

console.log(`[shared] ${Object.keys(current).length} shared files match.`);
