import pg from "pg";

const pool = new pg.Pool({
  connectionString: "postgresql://postgres:postgres@localhost:5432/college_saas?schema=public",
});

async function inspectTable() {
  try {
    const res = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'templates'");
    console.log("COLUMNS IN templates TABLE:", res.rows.map(r => r.column_name));

    const check = await pool.query("SELECT * FROM templates LIMIT 2");
    console.log("SAMPLE ROW:", check.rows[0]);
  } catch (err) {
    console.error("Error inspecting table:", err);
  } finally {
    await pool.end();
  }
}

inspectTable();
