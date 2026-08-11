import pg from "pg";

const pool = new pg.Pool({
  connectionString: "postgresql://postgres:postgres@localhost:5432/college_saas?schema=public",
});

const VIT_NAVBAR_CODE = `<header style="background: rgba(9, 14, 26, 0.95); backdrop-filter: blur(12px); color: #ffffff; padding: 14px 40px; font-family: system-ui, -apple-system, sans-serif; width: 100%; box-sizing: border-box; border-bottom: 1px solid rgba(255,255,255,0.12); position: sticky; top: 0; z-index: 1000; box-shadow: 0 10px 30px rgba(0,0,0,0.3);">
  <div style="max-width: 1280px; margin: 0 auto; display: flex; align-items: center; justify-content: space-between; gap: 16px;">
    <div style="display: flex; align-items: center; gap: 14px; flex-shrink: 0;">
      <img src="https://images.unsplash.com/photo-1592280771190-3e2e4d571952?w=120&auto=format&fit=crop&q=80" alt="University Logo" data-logo="true" style="width: 44px; height: 44px; object-fit: cover; border-radius: 50%; background: #ffffff; padding: 2px; border: 2px solid rgba(255,255,255,0.3); cursor: pointer;" title="Right-click to edit university logo!" />
      <div>
        <span style="font-size: 18px; font-weight: 900; color: #ffffff; letter-spacing: 0.03em; display: block; line-height: 1.1;">VELLORE INSTITUTE OF TECHNOLOGY</span>
        <span style="font-size: 10px; color: #38bdf8; font-weight: 800; text-transform: uppercase; letter-spacing: 0.12em;">DEEMED TO BE UNIVERSITY</span>
      </div>
    </div>

    <nav class="desktop-nav-links" style="display: flex; align-items: center; gap: clamp(10px, 1.6vw, 24px); font-size: 13px; font-weight: 800; flex-wrap: nowrap;">
      <a href="#home" style="color: #ffffff; text-decoration: none; padding: 6px 0; white-space: nowrap;">Home</a>
      <a href="#about" style="color: #e2e8f0; text-decoration: none; padding: 6px 0; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px;">About <span style="font-size: 9px; opacity: 0.7;">▾</span></a>
      <a href="#courses" style="color: #e2e8f0; text-decoration: none; padding: 6px 0; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px;">Academics <span style="font-size: 9px; opacity: 0.7;">▾</span></a>
      <a href="#admissions" style="color: #e2e8f0; text-decoration: none; padding: 6px 0; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px;">Admissions <span style="font-size: 9px; opacity: 0.7;">▾</span></a>
      <a href="#placements" style="color: #e2e8f0; text-decoration: none; padding: 6px 0; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px;">Career Development <span style="font-size: 9px; opacity: 0.7;">▾</span></a>
      <a href="#research" style="color: #e2e8f0; text-decoration: none; padding: 6px 0; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px;">Research <span style="font-size: 9px; opacity: 0.7;">▾</span></a>
      <a href="#gallery" style="color: #e2e8f0; text-decoration: none; padding: 6px 0; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px;">Campus Life <span style="font-size: 9px; opacity: 0.7;">▾</span></a>
    </nav>

    <a href="#contact" class="desktop-apply-btn" style="background: #2563eb; color: #ffffff; padding: 9px 22px; border-radius: 8px; font-size: 13px; font-weight: 800; text-decoration: none; white-space: nowrap; flex-shrink: 0; box-shadow: 0 4px 14px rgba(37,99,235,0.4);">Apply 2026</a>

    <button class="hamburger-toggle-btn" style="display: none; background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); color: #ffffff; padding: 8px 14px; border-radius: 8px; font-size: 20px; cursor: pointer; align-items: center; justify-content: center;" aria-label="Toggle Navigation Menu">
      ☰
    </button>
  </div>

  <div class="mobile-drawer-menu" style="display: none; width: 100%; background: #090e1a; border-top: 1px solid rgba(255,255,255,0.1); padding: 16px 20px; margin-top: 14px; box-shadow: 0 10px 30px rgba(0,0,0,0.5);">
    <nav style="display: flex; flex-direction: column; gap: 6px; font-size: 14px; font-weight: 800;">
      <a href="#home" style="color: #ffffff; text-decoration: none; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06);">Home</a>
      <a href="#about" style="color: #cbd5e1; text-decoration: none; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06);">About Institution</a>
      <a href="#courses" style="color: #cbd5e1; text-decoration: none; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06);">Academics & Specializations</a>
      <a href="#admissions" style="color: #cbd5e1; text-decoration: none; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06);">Admissions 2026</a>
      <a href="#placements" style="color: #cbd5e1; text-decoration: none; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06);">Career Development & Placements</a>
      <a href="#research" style="color: #cbd5e1; text-decoration: none; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06);">Research & Innovation</a>
      <a href="#gallery" style="color: #cbd5e1; text-decoration: none; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.06);">Campus Life & Facilities</a>
      <a href="#contact" style="color: #38bdf8; text-decoration: none; padding: 10px 0;">Contact Helpdesk</a>
    </nav>
  </div>
</header>`;

async function updateHeaderTemplatesInDb() {
  try {
    console.log("Updating header/navbar templates in local PostgreSQL database...");
    const res = await pool.query(
      `UPDATE templates 
       SET code = $1 
       WHERE LOWER(name) LIKE '%header%' 
          OR LOWER(name) LIKE '%navbar%' 
          OR LOWER(name) LIKE '%navigation%' 
          OR code LIKE '%UNIVERSAL%'
          OR code LIKE '%universal%'`,
      [VIT_NAVBAR_CODE]
    );
    console.log(`Updated ${res.rowCount} header template rows in local DB!`);
  } catch (err) {
    console.error("Update error:", err);
  } finally {
    await pool.end();
  }
}

updateHeaderTemplatesInDb();
