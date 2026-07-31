import "dotenv/config";
import { createPool } from "../src/lib/db-pool.ts";

const pool = createPool();

async function main() {
  console.log("Clearing all templates and college sections from database...");

  // 1. Delete all college sections across all pages
  const r0 = await pool.query("DELETE FROM college_sections");
  console.log(`Deleted ${r0.rowCount} college sections across all pages.`);

  // 2. Clear template_id on colleges
  const r1 = await pool.query("UPDATE colleges SET template_id = NULL");
  console.log(`Unlinked template_id on ${r1.rowCount} colleges.`);

  // 3. Delete all template sections
  const r2 = await pool.query("DELETE FROM sections");
  console.log(`Deleted ${r2.rowCount} template sections.`);

  // 4. Delete all templates
  const r3 = await pool.query("DELETE FROM templates");
  console.log(`Deleted ${r3.rowCount} templates.`);

  console.log("All templates and page sections successfully removed from database!");
  await pool.end();
}

main().catch(async (err) => {
  console.error("Error clearing templates:", err);
  await pool.end();
  process.exit(1);
});
