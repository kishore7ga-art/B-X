import "dotenv/config";
import { createPool } from "../src/lib/db-pool.ts";

const pool = createPool();

async function main() {
  console.log("Ensuring kishore7ga college exists in PostgreSQL database...");

  const res = await pool.query(
    "SELECT id, name, subdomain, status FROM colleges WHERE subdomain = $1 OR subdomain = $2",
    ["kishore7ga", "kishore7ga-college"]
  );

  if (res.rows.length === 0) {
    const collegeId = "college-kishore7ga-" + Date.now();
    await pool.query(
      "INSERT INTO colleges (id, name, subdomain, status) VALUES ($1, $2, $3, $4)",
      [collegeId, "Kishore7ga Institute of Technology & Science", "kishore7ga", "PUBLISHED"]
    );
    console.log(`Created college 'kishore7ga' (${collegeId}) with status PUBLISHED.`);

    const pageId = "page-home-" + Date.now();
    await pool.query(
      "INSERT INTO pages (id, college_id, slug, title, nav_order) VALUES ($1, $2, $3, $4, 0)",
      [pageId, collegeId, "home", "Home"]
    );
    console.log(`Created home page (${pageId}) for college.`);
  } else {
    console.log("Existing college(s) found:", res.rows);
    await pool.query(
      "UPDATE colleges SET status = 'PUBLISHED' WHERE subdomain = $1 OR subdomain = $2",
      ["kishore7ga", "kishore7ga-college"]
    );
    console.log("Updated college status to PUBLISHED.");
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error("Error ensuring kishore7ga college:", err);
  await pool.end();
  process.exit(1);
});
