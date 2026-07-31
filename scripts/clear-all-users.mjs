import "dotenv/config";
import { createPool } from "../src/lib/db-pool.ts";

const pool = createPool();

async function main() {
  console.log("Clearing all users and access requests from database...");

  // 1. Delete all access requests
  const r1 = await pool.query("DELETE FROM access_requests");
  console.log(`Deleted ${r1.rowCount} access requests.`);

  // 2. Delete all users
  const r2 = await pool.query("DELETE FROM users");
  console.log(`Deleted ${r2.rowCount} users.`);

  console.log("All users and access requests successfully removed from database!");
  await pool.end();
}

main().catch(async (err) => {
  console.error("Error clearing users:", err);
  await pool.end();
  process.exit(1);
});
