import "dotenv/config";
import { createPool } from "../src/lib/db-pool.ts";
import bcrypt from "bcryptjs";

const pool = createPool();
const EMAIL = "kishore7ga@gmail.com";
const PASSWORD = "kishore@7";

async function main() {
  // List all users
  const { rows: users } = await pool.query(
    "SELECT id, email, status, college_id FROM users ORDER BY created_at"
  );
  console.log("=== USERS ===");
  console.log(JSON.stringify(users, null, 2));

  const hash = await bcrypt.hash(PASSWORD, 12);

  const existing = users.find(u => u.email.toLowerCase() === EMAIL.toLowerCase());

  if (existing) {
    await pool.query(
      "UPDATE users SET password_hash = $1, status = 'ACTIVE' WHERE id = $2",
      [hash, existing.id]
    );
    // Get college subdomain
    const { rows: [college] } = await pool.query(
      "SELECT subdomain FROM colleges WHERE id = $1",
      [existing.college_id]
    );
    console.log(`\n✅ Password updated for ${EMAIL}`);
    console.log(`   College subdomain: ${college?.subdomain}`);
  } else {
    // Find first non-demo college
    const { rows: colleges } = await pool.query(
      "SELECT id, subdomain FROM colleges WHERE is_demo = false ORDER BY created_at LIMIT 1"
    );
    let collegeId;
    let subdomain;
    if (colleges.length > 0) {
      collegeId = colleges[0].id;
      subdomain = colleges[0].subdomain;
    } else {
      const { rows: [created] } = await pool.query(
        "INSERT INTO colleges (id, name, subdomain, status) VALUES (gen_random_uuid(), 'Greenfield College', 'greenfield', 'PUBLISHED') RETURNING id, subdomain"
      );
      collegeId = created.id;
      subdomain = created.subdomain;
    }

    await pool.query(
      "INSERT INTO users (id, email, password_hash, status, college_id) VALUES (gen_random_uuid(), $1, $2, 'ACTIVE', $3)",
      [EMAIL, hash, collegeId]
    );
    console.log(`\n✅ Created user ${EMAIL} -> college: ${subdomain}`);
  }

  // Verify with login test
  const { rows: [check] } = await pool.query(
    "SELECT u.email, u.status, c.subdomain FROM users u JOIN colleges c ON c.id = u.college_id WHERE LOWER(u.email) = LOWER($1)",
    [EMAIL]
  );
  console.log("\n=== VERIFICATION ===");
  console.log(JSON.stringify(check, null, 2));

  await pool.end();
}

main().catch(async e => {
  console.error("Error:", e.message);
  await pool.end();
  process.exit(1);
});
