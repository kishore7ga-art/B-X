/**
 * Production entrypoint: seed Mongoose MongoDB reference data, then serve.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";

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

if (process.env.SEED_ON_START !== "false") {
  console.log("[start] seeding MongoDB reference data (default website templates)");
  await run("node", ["scripts/seed-mongodb.mjs"]).catch(() => null);
}

console.log("[start] starting Express API server...");
const entryPoint = fs.existsSync("dist/server.js") ? "dist/server.js" : "src/server.ts";
if (entryPoint.endsWith(".js")) {
  process.exit(await run("node", [entryPoint]));
} else {
  process.exit(await run("npx", ["tsx", entryPoint]));
}
