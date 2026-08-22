import pg from "pg";

const pool = new pg.Pool({
  connectionString: "postgresql://postgres:postgres@localhost:5432/college_saas?schema=public",
});

async function syncAll43AdminTemplates() {
  try {
    console.log("Fetching all 43 production admin templates from https://api.webxite.org/api/v1/admin/templates...");
    const res = await fetch("https://api.webxite.org/api/v1/admin/templates");
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }
    const data = await res.json();
    const templates = data.templates || [];
    console.log(`Fetched ${templates.length} templates from production API!`);

    // Insert or update every template in local PostgreSQL
    let count = 0;
    for (const t of templates) {
      const codeStr = (t.code || t.html || t.content || "").trim();
      if (!codeStr) continue;

      const id = t.id || `tpl-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const name = t.name || t.title || "Section Template";
      const description = t.description || name;

      await pool.query(
        `INSERT INTO templates (id, name, description, code, is_published, created_by_email, created_at)
         VALUES ($1, $2, $3, $4, true, 'admin@xite.co.in', NOW())
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, code = EXCLUDED.code`,
        [id, name, description, codeStr]
      );
      count++;
    }

    console.log(`Successfully synced all ${count} templates into local PostgreSQL!`);

    const check = await pool.query("SELECT count(*) FROM templates");
    console.log(`TOTAL TEMPLATES IN LOCAL DB NOW: ${check.rows[0].count}`);
  } catch (err) {
    console.error("Sync error:", err);
  } finally {
    await pool.end();
  }
}

syncAll43AdminTemplates();
