import "dotenv/config";
import { createPool } from "../src/lib/db-pool.ts";

const pool = createPool();

async function main() {
  // Check user + college link
  const { rows: users } = await pool.query(`
    SELECT u.id, u.email, u.status, u.college_id,
           c.id as cid, c.name as cname, c.subdomain
    FROM users u
    LEFT JOIN colleges c ON c.id = u.college_id
    ORDER BY u.created_at
  `);
  console.log("=== USERS + COLLEGE ===");
  console.table(users);

  // Also check college directly
  const { rows: colleges } = await pool.query(`
    SELECT id, name, subdomain, status, is_demo FROM colleges ORDER BY created_at LIMIT 5
  `);
  console.log("=== COLLEGES ===");
  console.table(colleges);

  await pool.end();
}

main().catch(async e => { console.error(e); await pool.end(); process.exit(1); });
