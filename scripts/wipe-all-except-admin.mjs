import "dotenv/config";
import bcrypt from "bcryptjs";
import { createPool } from "../src/lib/db-pool.ts";

const pool = createPool();

async function main() {
  console.log("Wiping all tenant, page, user, and audit data from database while keeping Admin...");

  // 1. Delete college sections
  const cs = await pool.query("DELETE FROM college_sections");
  console.log(`Deleted ${cs.rowCount} college_sections.`);

  // 2. Delete pages
  const p = await pool.query("DELETE FROM pages");
  console.log(`Deleted ${p.rowCount} pages.`);

  // 3. Delete access requests
  const ar = await pool.query("DELETE FROM access_requests");
  console.log(`Deleted ${ar.rowCount} access_requests.`);

  // 4. Delete users
  const u = await pool.query("DELETE FROM users");
  console.log(`Deleted ${u.rowCount} users.`);

  // 5. Delete colleges
  const c = await pool.query("DELETE FROM colleges");
  console.log(`Deleted ${c.rowCount} colleges.`);

  // 6. Delete template sections
  const ts = await pool.query("DELETE FROM sections");
  console.log(`Deleted ${ts.rowCount} sections.`);

  // 7. Delete templates
  const t = await pool.query("DELETE FROM templates");
  console.log(`Deleted ${t.rowCount} templates.`);

  // 8. Delete audit log
  const al = await pool.query("DELETE FROM audit_log");
  console.log(`Deleted ${al.rowCount} audit_log entries.`);

  // 9. Ensure Super Admin user exists with password 2008
  const hash = await bcrypt.hash("2008", 12);
  await pool.query(
    `INSERT INTO admin_users (id, email, password_hash, created_at)
     VALUES ('admin-1', 'admin@xite.co.in', $1, NOW())
     ON CONFLICT (email) DO UPDATE SET password_hash = $1`,
    [hash]
  );
  console.log("Super Admin admin@xite.co.in verified with password '2008'.");

  console.log("Database wipe complete! All non-admin data removed.");
  await pool.end();
}

main().catch(async (err) => {
  console.error("Error wiping database:", err);
  await pool.end();
  process.exit(1);
});
