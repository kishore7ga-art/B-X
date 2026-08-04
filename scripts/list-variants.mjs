import "dotenv/config";
import { createPool } from "../src/lib/db-pool.ts";

const pool = createPool();

async function main() {
  const { rows } = await pool.query("SELECT * FROM college_sections LIMIT 1");
  console.log("=== COLLEGE SECTIONS COLUMNS ===");
  if (rows.length > 0) {
    console.log(Object.keys(rows[0]));
    console.log(rows[0]);
  } else {
    console.log("No rows in college_sections");
  }

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
