import pg from "pg";

const pool = new pg.Pool({
  connectionString: "postgresql://postgres:postgres@localhost:5432/college_saas?schema=public",
});

async function checkSpecificTemplate() {
  try {
    const res = await pool.query("SELECT id, name, description, length(code) as code_len FROM templates WHERE id = 'cmskkwo0u002c65ml7ghg3wot'");
    console.log("FOUND SPECIFIC TEMPLATE:", res.rows);

    const all = await pool.query("SELECT id, name FROM templates");
    console.log("ALL TEMPLATES IN DB:", all.rows);
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await pool.end();
  }
}

checkSpecificTemplate();
