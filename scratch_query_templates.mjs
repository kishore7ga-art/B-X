import pg from "pg";

const pool = new pg.Pool({
  connectionString: "postgresql://postgres:postgres@localhost:5432/college_saas?schema=public",
});

async function run() {
  try {
    const res = await pool.query("SELECT id, name, description, length(code) as code_len, substring(code from 1 for 100) as code_sample FROM templates");
    console.log("TOTAL TEMPLATES IN DB:", res.rows.length);
    res.rows.forEach((r, idx) => {
      console.log(`Template #${idx + 1}: id=${r.id}, name="${r.name}", len=${r.code_len}`);
      console.log(`   Sample: ${JSON.stringify(r.code_sample)}`);
    });
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await pool.end();
  }
}

run();
