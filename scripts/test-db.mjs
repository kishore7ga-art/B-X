import "dotenv/config";
import { createPool } from "../src/lib/db-pool.ts";

const pool = createPool();

async function testConnection() {
  console.log("Testing PostgreSQL Database Connection...");
  const res = await pool.query("SELECT current_database(), current_user, version();");
  console.log("Connected Successfully!");
  console.log("Database Name:", res.rows[0].current_database);
  console.log("Database User:", res.rows[0].current_user);
  console.log("PostgreSQL Version:", res.rows[0].version.substring(0, 40));

  const colleges = await pool.query("SELECT COUNT(*) FROM colleges;");
  console.log("Colleges Count:", colleges.rows[0].count);

  const users = await pool.query("SELECT COUNT(*) FROM users;");
  console.log("Users Count:", users.rows[0].count);

  const templates = await pool.query("SELECT COUNT(*) FROM templates;");
  console.log("Templates Count:", templates.rows[0].count);

  await pool.end();
}

testConnection().catch(async (err) => {
  console.error("Database Connection Failed:", err);
  await pool.end();
  process.exit(1);
});
