/**
 * One starting section for each of the twenty categories.
 *
 * ── What these are for ─────────────────────────────────────────────────────
 *
 * The Default Website is what a tenant's page is seeded from, and it shipped
 * with a header and a footer on `/home` and nothing at all on the other four
 * pages. So every college started with two sections and an empty About page,
 * and the Admin's own "Add Section" picker offered eight presets covering eight
 * of the twenty categories — the other twelve could only be filled by pasting
 * markup by hand.
 *
 * These are the fallback half of `fillPagesWithEverySection`: a published
 * template from Admin › Templates wins for its category, and a category with no
 * template gets the block below rather than being skipped. That is what makes
 * "every page has all twenty" true regardless of what the library happens to
 * hold, and it degrades in the right direction — as the library fills up, fewer
 * of these are ever used.
 *
 * ── Why they are written like this ─────────────────────────────────────────
 *
 * Inline styles, not a `<style>` block. Two reasons, both mechanical:
 *
 *  - `sectionResponsiveCss` — the platform's responsive engine — matches on
 *    inline style attributes (`[style*="grid-template-columns"]`), because
 *    hand-written desktop CSS is exactly what cannot adapt on its own. Markup
 *    written this way is responsive on every surface without anybody
 *    maintaining a breakpoint for it.
 *  - `HEADER_SECTION_CODE` and `FOOTER_SECTION_CODE`, which these join, are
 *    written the same way, and a set of starters that looked like two different
 *    authors would compose into a site that looked like two different sites.
 *
 * The palette is deliberately the one `editor-themes.ts` tokenises: `#0d1527`
 * is the header token, `#090d16` the footer, `#0f172a` the surface, `#1e293b`
 * the raised surface, `#2563eb` the accent, `#cbd5e1` and `#94a3b8` muted text.
 * A tenant who picks a theme therefore retints all twenty in one attribute
 * write, rather than getting nineteen sections in the platform's blue and one
 * in theirs.
 *
 * No `<iframe>` anywhere, including in Map: `sanitizeSectionHtml` discards it,
 * so an embed written here would arrive at the tenant as an empty section.
 * No viewport units: see `viewportUnitsToContainer` in `section-runtime.ts`.
 */
import { SECTION_CATEGORY_IDS, type SectionCategoryId } from "@/lib/sections/categories";

export type SectionStarter = {
  /** The section's name in the Admin list and in the editor's section rail. */
  title: string;
  /** Raw HTML, rendered as-is. See `SECTION-ARCHITECTURE.md`. */
  code: string;
};

/* ── Shared idiom ─────────────────────────────────────────────────────────
 *
 * Not a template engine — just the four strings that would otherwise be typed
 * twenty times and drift on the nineteenth.
 */

const SECTION = "padding: 72px 40px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;";
const CONTAINER = "max-width: 1200px; margin: 0 auto;";
const H2 = "font-size: 34px; font-weight: 900; letter-spacing: -0.02em; margin: 0 0 14px;";
const EYEBROW = "font-size: 12px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: #2563eb; margin: 0 0 10px;";
const LEAD = "font-size: 16px; line-height: 1.75; color: #cbd5e1; margin: 0;";
const CARD = "background: #1e293b; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 26px;";

/**
 * The starters, keyed by canonical id.
 *
 * A `Record<SectionCategoryId, …>` rather than an array: adding a category to
 * `SECTION_CATEGORY_IDS` and forgetting to write its starter fails the build
 * here, which is the same guard the Admin's category list and icon map already
 * use. A missing starter would otherwise surface as one page in twenty coming
 * out with a gap nobody could explain.
 */
export const SECTION_STARTERS: Record<SectionCategoryId, SectionStarter> = {
  navbar: {
    title: "Navbar / Header",
    code: `<header style="background: #0d1527; color: #ffffff; padding: 18px 40px; display: flex; align-items: center; justify-content: space-between; gap: 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box; border-bottom: 1px solid rgba(255,255,255,0.1);">
  <div style="display: flex; align-items: center; gap: 12px;">
    <div style="width: 40px; height: 40px; border-radius: 10px; background: #2563eb; color: #ffffff; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 18px;">GU</div>
    <span style="font-size: 20px; font-weight: 900; white-space: nowrap;">GREENFIELD UNIVERSITY</span>
  </div>
  <nav style="display: flex; flex-wrap: wrap; gap: 24px; font-size: 14px; font-weight: 700;">
    <a href="#about" style="color: #cbd5e1; text-decoration: none;">About</a>
    <a href="#courses" style="color: #cbd5e1; text-decoration: none;">Academics</a>
    <a href="#admissions" style="color: #cbd5e1; text-decoration: none;">Admissions</a>
    <a href="#placements" style="color: #cbd5e1; text-decoration: none;">Placements</a>
    <a href="#contact" style="color: #cbd5e1; text-decoration: none;">Contact</a>
  </nav>
  <a href="#apply" style="background: #2563eb; color: #ffffff; padding: 10px 24px; border-radius: 10px; font-size: 13px; font-weight: 800; text-decoration: none; white-space: nowrap;">Apply Now</a>
</header>`,
  },

  hero: {
    title: "Hero Banner",
    code: `<section style="background: #0f172a; color: #ffffff; ${SECTION} padding-top: 96px; padding-bottom: 96px;">
  <div style="${CONTAINER} max-width: 860px; text-align: center;">
    <p style="${EYEBROW}">Admissions open for 2027</p>
    <h1 style="font-size: 54px; font-weight: 900; line-height: 1.08; letter-spacing: -0.03em; margin: 0 0 18px;">An education that holds its value</h1>
    <p style="${LEAD} font-size: 18px;">Nineteen departments, a residential campus, and a teaching faculty that also does the research. Applications for the 2027 intake close on 15 January.</p>
    <div style="display: flex; flex-wrap: wrap; gap: 14px; justify-content: center; margin-top: 32px;">
      <a href="#apply" style="background: #2563eb; color: #ffffff; padding: 15px 34px; border-radius: 12px; font-size: 14px; font-weight: 800; text-decoration: none;">Start an application</a>
      <a href="#visit" style="border: 1px solid rgba(255,255,255,0.28); color: #ffffff; padding: 15px 34px; border-radius: 12px; font-size: 14px; font-weight: 800; text-decoration: none;">Book a campus visit</a>
    </div>
  </div>
</section>`,
  },

  cta: {
    title: "Call to Action",
    code: `<section style="background: #2563eb; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER} display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 28px;">
    <div>
      <h2 style="${H2} font-size: 30px;">Applications close on 15 January</h2>
      <p style="font-size: 16px; line-height: 1.7; color: #ffffff; margin: 0; opacity: 0.9;">One form, three programmes, no application fee.</p>
    </div>
    <a href="#apply" style="background: #ffffff; color: #2563eb; padding: 16px 38px; border-radius: 999px; font-size: 14px; font-weight: 900; letter-spacing: 0.04em; text-transform: uppercase; text-decoration: none; white-space: nowrap;">Apply now</a>
  </div>
</section>`,
  },

  highlights: {
    title: "College Highlights / Stats",
    code: `<section style="background: #0d1527; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER} display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; text-align: center;">
    <div><div style="font-size: 46px; font-weight: 900; letter-spacing: -0.03em;">A++</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; margin-top: 8px;">NAAC grade</div></div>
    <div><div style="font-size: 46px; font-weight: 900; letter-spacing: -0.03em;">1:8</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; margin-top: 8px;">Faculty ratio</div></div>
    <div><div style="font-size: 46px; font-weight: 900; letter-spacing: -0.03em;">94%</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; margin-top: 8px;">Placed in 2026</div></div>
    <div><div style="font-size: 46px; font-weight: 900; letter-spacing: -0.03em;">269</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; margin-top: 8px;">Acre campus</div></div>
  </div>
</section>`,
  },

  about: {
    title: "About College",
    code: `<section style="background: #0f172a; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER} display: grid; grid-template-columns: repeat(2, 1fr); gap: 48px; align-items: center;">
    <div>
      <p style="${EYEBROW}">About the college</p>
      <h2 style="${H2}">Founded in 1962, and still one walk across</h2>
      <p style="${LEAD} margin-bottom: 16px;">Greenfield began as a single science faculty and now teaches nineteen departments on one residential campus. The scale is deliberate: every undergraduate is taught by someone who publishes in their field.</p>
      <p style="${LEAD}">Accredited A++ by NAAC, approved by AICTE and UGC, and ranked in the national top fifty for engineering since 2019.</p>
    </div>
    <div style="${CARD}">
      <h3 style="font-size: 19px; font-weight: 800; margin: 0 0 16px;">At a glance</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 15px; color: #cbd5e1;">
        <tbody>
          <tr><td style="padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.08);">Founded</td><td style="padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: right; color: #ffffff; font-weight: 700;">1962</td></tr>
          <tr><td style="padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.08);">Students</td><td style="padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: right; color: #ffffff; font-weight: 700;">6,700</td></tr>
          <tr><td style="padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.08);">Faculty</td><td style="padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: right; color: #ffffff; font-weight: 700;">943</td></tr>
          <tr><td style="padding: 9px 0;">Departments</td><td style="padding: 9px 0; text-align: right; color: #ffffff; font-weight: 700;">19</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</section>`,
  },

  vision: {
    title: "Vision & Mission",
    code: `<section style="background: #0d1527; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER}">
    <p style="${EYEBROW}">What we are for</p>
    <h2 style="${H2} margin-bottom: 34px;">Vision &amp; mission</h2>
    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px;">
      <div style="${CARD}">
        <h3 style="font-size: 19px; font-weight: 800; margin: 0 0 12px;">Vision</h3>
        <p style="${LEAD}">To be the institution a student from any background can reach on merit, and leave able to do work that matters.</p>
      </div>
      <div style="${CARD}">
        <h3 style="font-size: 19px; font-weight: 800; margin: 0 0 12px;">Mission</h3>
        <ul style="margin: 0; padding-left: 20px; color: #cbd5e1; font-size: 15px; line-height: 1.9;">
          <li>Teach small, and teach the people who do the research.</li>
          <li>Keep admission on academic merit and need-blind on fees.</li>
          <li>Publish what we find, and put it to use locally first.</li>
        </ul>
      </div>
    </div>
  </div>
</section>`,
  },

  courses: {
    title: "Courses / Programs Offered",
    code: `<section style="background: #0f172a; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER}">
    <p style="${EYEBROW}">Academics</p>
    <h2 style="${H2} margin-bottom: 34px;">Programmes offered</h2>
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;">
      <div style="${CARD}">
        <div style="font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: #2563eb;">Undergraduate</div>
        <h3 style="font-size: 20px; font-weight: 800; margin: 10px 0 10px;">B.E. / B.Tech</h3>
        <p style="${LEAD} font-size: 15px;">Eight branches, four years, AICTE approved. 720 seats.</p>
      </div>
      <div style="${CARD}">
        <div style="font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: #2563eb;">Postgraduate</div>
        <h3 style="font-size: 20px; font-weight: 800; margin: 10px 0 10px;">M.E. / M.Tech / MBA</h3>
        <p style="${LEAD} font-size: 15px;">Eleven specialisations, two years, with a funded thesis term.</p>
      </div>
      <div style="${CARD}">
        <div style="font-size: 12px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: #2563eb;">Doctoral</div>
        <h3 style="font-size: 20px; font-weight: 800; margin: 10px 0 10px;">Ph.D</h3>
        <p style="${LEAD} font-size: 15px;">Full-time and external, across all nineteen departments.</p>
      </div>
    </div>
  </div>
</section>`,
  },

  departments: {
    title: "Academic Departments",
    code: `<section style="background: #0d1527; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER}">
    <p style="${EYEBROW}">Faculties</p>
    <h2 style="${H2} margin-bottom: 34px;">Academic departments</h2>
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 18px;">
      <div style="${CARD} padding: 20px;"><h3 style="font-size: 16px; font-weight: 800; margin: 0 0 6px;">Computer Science</h3><p style="font-size: 13px; color: #94a3b8; margin: 0;">142 faculty &middot; 1,180 students</p></div>
      <div style="${CARD} padding: 20px;"><h3 style="font-size: 16px; font-weight: 800; margin: 0 0 6px;">Mechanical</h3><p style="font-size: 13px; color: #94a3b8; margin: 0;">96 faculty &middot; 860 students</p></div>
      <div style="${CARD} padding: 20px;"><h3 style="font-size: 16px; font-weight: 800; margin: 0 0 6px;">Electrical</h3><p style="font-size: 13px; color: #94a3b8; margin: 0;">88 faculty &middot; 790 students</p></div>
      <div style="${CARD} padding: 20px;"><h3 style="font-size: 16px; font-weight: 800; margin: 0 0 6px;">Civil</h3><p style="font-size: 13px; color: #94a3b8; margin: 0;">74 faculty &middot; 640 students</p></div>
      <div style="${CARD} padding: 20px;"><h3 style="font-size: 16px; font-weight: 800; margin: 0 0 6px;">Sciences</h3><p style="font-size: 13px; color: #94a3b8; margin: 0;">110 faculty &middot; 520 students</p></div>
      <div style="${CARD} padding: 20px;"><h3 style="font-size: 16px; font-weight: 800; margin: 0 0 6px;">Management</h3><p style="font-size: 13px; color: #94a3b8; margin: 0;">61 faculty &middot; 430 students</p></div>
      <div style="${CARD} padding: 20px;"><h3 style="font-size: 16px; font-weight: 800; margin: 0 0 6px;">Architecture</h3><p style="font-size: 13px; color: #94a3b8; margin: 0;">38 faculty &middot; 210 students</p></div>
      <div style="${CARD} padding: 20px;"><h3 style="font-size: 16px; font-weight: 800; margin: 0 0 6px;">Humanities</h3><p style="font-size: 13px; color: #94a3b8; margin: 0;">54 faculty &middot; 300 students</p></div>
    </div>
  </div>
</section>`,
  },

  admissions: {
    title: "Admission Section",
    code: `<section style="background: #0f172a; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER} display: grid; grid-template-columns: repeat(2, 1fr); gap: 48px;">
    <div>
      <p style="${EYEBROW}">Admissions 2027</p>
      <h2 style="${H2}">How to apply</h2>
      <ol style="margin: 18px 0 0; padding-left: 20px; color: #cbd5e1; font-size: 16px; line-height: 2;">
        <li>Check eligibility for your programme.</li>
        <li>Submit the online form with your transcripts.</li>
        <li>Sit the entrance test on 8 February.</li>
        <li>Attend counselling and confirm your seat.</li>
      </ol>
      <a href="#apply" style="display: inline-block; margin-top: 26px; background: #2563eb; color: #ffffff; padding: 14px 32px; border-radius: 12px; font-size: 14px; font-weight: 800; text-decoration: none;">Open the application</a>
    </div>
    <div style="${CARD}">
      <h3 style="font-size: 19px; font-weight: 800; margin: 0 0 16px;">Fee structure</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 15px; color: #cbd5e1;">
        <tbody>
          <tr><td style="padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.08);">B.E. / B.Tech, per year</td><td style="padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: right; color: #ffffff; font-weight: 700;">&#8377;1,45,000</td></tr>
          <tr><td style="padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.08);">M.Tech, per year</td><td style="padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.08); text-align: right; color: #ffffff; font-weight: 700;">&#8377;98,000</td></tr>
          <tr><td style="padding: 9px 0;">Hostel &amp; mess, per year</td><td style="padding: 9px 0; text-align: right; color: #ffffff; font-weight: 700;">&#8377;72,000</td></tr>
        </tbody>
      </table>
      <p style="font-size: 13px; color: #94a3b8; margin: 16px 0 0;">Merit and need-based scholarships cover up to 100% of tuition.</p>
    </div>
  </div>
</section>`,
  },

  placements: {
    title: "Placement & Top Recruiters",
    code: `<section style="background: #0d1527; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER}">
    <p style="${EYEBROW}">Careers</p>
    <h2 style="${H2} margin-bottom: 34px;">Placements &amp; recruiters</h2>
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-bottom: 32px;">
      <div style="${CARD} text-align: center;"><div style="font-size: 40px; font-weight: 900; letter-spacing: -0.03em;">&#8377;54 LPA</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; margin-top: 8px;">Highest package</div></div>
      <div style="${CARD} text-align: center;"><div style="font-size: 40px; font-weight: 900; letter-spacing: -0.03em;">&#8377;9.8 LPA</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; margin-top: 8px;">Average package</div></div>
      <div style="${CARD} text-align: center;"><div style="font-size: 40px; font-weight: 900; letter-spacing: -0.03em;">312</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; margin-top: 8px;">Recruiters on campus</div></div>
    </div>
    <div style="display: grid; grid-template-columns: repeat(6, 1fr); gap: 14px;">
      <div style="border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; text-align: center; font-size: 14px; font-weight: 800; color: #cbd5e1;">Infosys</div>
      <div style="border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; text-align: center; font-size: 14px; font-weight: 800; color: #cbd5e1;">TCS</div>
      <div style="border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; text-align: center; font-size: 14px; font-weight: 800; color: #cbd5e1;">Zoho</div>
      <div style="border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; text-align: center; font-size: 14px; font-weight: 800; color: #cbd5e1;">L&amp;T</div>
      <div style="border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; text-align: center; font-size: 14px; font-weight: 800; color: #cbd5e1;">Ashok Leyland</div>
      <div style="border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; padding: 18px; text-align: center; font-size: 14px; font-weight: 800; color: #cbd5e1;">Freshworks</div>
    </div>
  </div>
</section>`,
  },

  facilities: {
    title: "Campus Facilities",
    code: `<section style="background: #0f172a; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER}">
    <p style="${EYEBROW}">Infrastructure</p>
    <h2 style="${H2} margin-bottom: 34px;">Campus facilities</h2>
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;">
      <div style="${CARD}"><h3 style="font-size: 19px; font-weight: 800; margin: 0 0 10px;">Central library</h3><p style="${LEAD} font-size: 15px;">240,000 volumes, 18 databases, open until midnight in term.</p></div>
      <div style="${CARD}"><h3 style="font-size: 19px; font-weight: 800; margin: 0 0 10px;">Residences</h3><p style="${LEAD} font-size: 15px;">Eleven halls, 4,200 beds, guaranteed for the first two years.</p></div>
      <div style="${CARD}"><h3 style="font-size: 19px; font-weight: 800; margin: 0 0 10px;">Sports complex</h3><p style="${LEAD} font-size: 15px;">Eight-lane track, olympic pool, and six indoor courts.</p></div>
      <div style="${CARD}"><h3 style="font-size: 19px; font-weight: 800; margin: 0 0 10px;">Laboratories</h3><p style="${LEAD} font-size: 15px;">62 teaching labs, refitted on a rolling five-year cycle.</p></div>
      <div style="${CARD}"><h3 style="font-size: 19px; font-weight: 800; margin: 0 0 10px;">Health centre</h3><p style="${LEAD} font-size: 15px;">Resident physician, on-call cover, and counselling by appointment.</p></div>
      <div style="${CARD}"><h3 style="font-size: 19px; font-weight: 800; margin: 0 0 10px;">Transport</h3><p style="${LEAD} font-size: 15px;">34 routes across the district, on a 20-minute headway.</p></div>
    </div>
  </div>
</section>`,
  },

  research: {
    title: "Research & Innovation",
    code: `<section style="background: #0d1527; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER} display: grid; grid-template-columns: repeat(2, 1fr); gap: 48px; align-items: center;">
    <div>
      <p style="${EYEBROW}">Research</p>
      <h2 style="${H2}">Work that leaves the building</h2>
      <p style="${LEAD}">Twelve funded centres, from water quality to power electronics. Undergraduates join a lab from the second year, and every thesis is examined externally.</p>
    </div>
    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px;">
      <div style="${CARD} padding: 22px;"><div style="font-size: 34px; font-weight: 900; letter-spacing: -0.03em;">184</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; margin-top: 6px;">Patents filed</div></div>
      <div style="${CARD} padding: 22px;"><div style="font-size: 34px; font-weight: 900; letter-spacing: -0.03em;">1,260</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; margin-top: 6px;">Papers since 2020</div></div>
      <div style="${CARD} padding: 22px;"><div style="font-size: 34px; font-weight: 900; letter-spacing: -0.03em;">12</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; margin-top: 6px;">Funded centres</div></div>
      <div style="${CARD} padding: 22px;"><div style="font-size: 34px; font-weight: 900; letter-spacing: -0.03em;">&#8377;42 Cr</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #94a3b8; margin-top: 6px;">Active grants</div></div>
    </div>
  </div>
</section>`,
  },

  news: {
    title: "News & Announcements",
    code: `<section style="background: #0f172a; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER}">
    <p style="${EYEBROW}">Notice board</p>
    <h2 style="${H2} margin-bottom: 34px;">News &amp; announcements</h2>
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;">
      <article style="${CARD}"><time style="font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #2563eb;">12 August 2026</time><h3 style="font-size: 18px; font-weight: 800; margin: 10px 0 8px;">Entrance test dates announced</h3><p style="${LEAD} font-size: 15px;">The 2027 entrance test will be held on 8 February at 22 centres.</p></article>
      <article style="${CARD}"><time style="font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #2563eb;">4 August 2026</time><h3 style="font-size: 18px; font-weight: 800; margin: 10px 0 8px;">New materials lab opens</h3><p style="${LEAD} font-size: 15px;">A &#8377;9 crore facility for structural testing enters service this term.</p></article>
      <article style="${CARD}"><time style="font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #2563eb;">28 July 2026</time><h3 style="font-size: 18px; font-weight: 800; margin: 10px 0 8px;">Placement season closes at 94%</h3><p style="${LEAD} font-size: 15px;">312 recruiters made 1,840 offers across all nineteen departments.</p></article>
    </div>
  </div>
</section>`,
  },

  events: {
    title: "Upcoming Events",
    code: `<section style="background: #0d1527; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER}">
    <p style="${EYEBROW}">Calendar</p>
    <h2 style="${H2} margin-bottom: 34px;">Upcoming events</h2>
    <div style="display: grid; grid-template-columns: repeat(1, 1fr); gap: 14px;">
      <div style="${CARD} padding: 22px; display: flex; flex-wrap: wrap; align-items: center; gap: 24px;"><div style="text-align: center; min-width: 76px;"><div style="font-size: 30px; font-weight: 900; line-height: 1;">14</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #94a3b8;">Sep</div></div><div><h3 style="font-size: 18px; font-weight: 800; margin: 0 0 6px;">Open day &amp; campus tour</h3><p style="font-size: 14px; color: #94a3b8; margin: 0;">09:30 &middot; Main quadrangle &middot; Registration required</p></div></div>
      <div style="${CARD} padding: 22px; display: flex; flex-wrap: wrap; align-items: center; gap: 24px;"><div style="text-align: center; min-width: 76px;"><div style="font-size: 30px; font-weight: 900; line-height: 1;">02</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #94a3b8;">Oct</div></div><div><h3 style="font-size: 18px; font-weight: 800; margin: 0 0 6px;">National symposium on clean water</h3><p style="font-size: 14px; color: #94a3b8; margin: 0;">All day &middot; Sarabhai Hall &middot; Open to the public</p></div></div>
      <div style="${CARD} padding: 22px; display: flex; flex-wrap: wrap; align-items: center; gap: 24px;"><div style="text-align: center; min-width: 76px;"><div style="font-size: 30px; font-weight: 900; line-height: 1;">21</div><div style="font-size: 12px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #94a3b8;">Nov</div></div><div><h3 style="font-size: 18px; font-weight: 800; margin: 0 0 6px;">Greenfest &mdash; annual cultural festival</h3><p style="font-size: 14px; color: #94a3b8; margin: 0;">Three days &middot; Across campus &middot; 40 events</p></div></div>
    </div>
  </div>
</section>`,
  },

  gallery: {
    title: "Gallery / Campus Life",
    code: `<section style="background: #0f172a; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER}">
    <p style="${EYEBROW}">Campus life</p>
    <h2 style="${H2} margin-bottom: 34px;">Gallery</h2>
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;">
      <figure style="margin: 0; border-radius: 14px; overflow: hidden; background: #1e293b; aspect-ratio: 4 / 3; display: flex; align-items: flex-end; padding: 16px;"><figcaption style="font-size: 13px; font-weight: 700; color: #cbd5e1;">The quadrangle in October</figcaption></figure>
      <figure style="margin: 0; border-radius: 14px; overflow: hidden; background: #24344d; aspect-ratio: 4 / 3; display: flex; align-items: flex-end; padding: 16px;"><figcaption style="font-size: 13px; font-weight: 700; color: #cbd5e1;">Structures lab</figcaption></figure>
      <figure style="margin: 0; border-radius: 14px; overflow: hidden; background: #1e293b; aspect-ratio: 4 / 3; display: flex; align-items: flex-end; padding: 16px;"><figcaption style="font-size: 13px; font-weight: 700; color: #cbd5e1;">Inter-hall athletics</figcaption></figure>
      <figure style="margin: 0; border-radius: 14px; overflow: hidden; background: #24344d; aspect-ratio: 4 / 3; display: flex; align-items: flex-end; padding: 16px;"><figcaption style="font-size: 13px; font-weight: 700; color: #cbd5e1;">Convocation 2026</figcaption></figure>
    </div>
    <p style="font-size: 13px; color: #94a3b8; margin: 18px 0 0;">Replace each panel with a photograph in the editor &mdash; the caption stays where it is.</p>
  </div>
</section>`,
  },

  testimonials: {
    title: "Student Testimonials",
    code: `<section style="background: #0d1527; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER}">
    <p style="${EYEBROW}">In their words</p>
    <h2 style="${H2} margin-bottom: 34px;">Students &amp; alumni</h2>
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;">
      <blockquote style="${CARD} margin: 0;"><p style="font-size: 16px; line-height: 1.75; color: #ffffff; margin: 0 0 18px;">&ldquo;I joined a lab in my second year and had a paper out before I graduated. That does not happen at a bigger place.&rdquo;</p><footer style="font-size: 13px; color: #94a3b8;"><strong style="color: #cbd5e1; display: block; font-size: 14px;">Anitha R.</strong>B.Tech Civil, 2024</footer></blockquote>
      <blockquote style="${CARD} margin: 0;"><p style="font-size: 16px; line-height: 1.75; color: #ffffff; margin: 0 0 18px;">&ldquo;The placement cell started working with me in the third year, not the week before the interviews.&rdquo;</p><footer style="font-size: 13px; color: #94a3b8;"><strong style="color: #cbd5e1; display: block; font-size: 14px;">Karthik S.</strong>B.E. CSE, 2025</footer></blockquote>
      <blockquote style="${CARD} margin: 0;"><p style="font-size: 16px; line-height: 1.75; color: #ffffff; margin: 0 0 18px;">&ldquo;Fourteen to a seminar. You cannot hide, and after a term you stop wanting to.&rdquo;</p><footer style="font-size: 13px; color: #94a3b8;"><strong style="color: #cbd5e1; display: block; font-size: 14px;">Meera P.</strong>M.A. Humanities, 2023</footer></blockquote>
    </div>
  </div>
</section>`,
  },

  achievements: {
    title: "Achievements & Awards",
    code: `<section style="background: #0f172a; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER}">
    <p style="${EYEBROW}">Recognition</p>
    <h2 style="${H2} margin-bottom: 34px;">Achievements &amp; awards</h2>
    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px;">
      <div style="${CARD} padding: 22px;"><h3 style="font-size: 17px; font-weight: 800; margin: 0 0 8px;">NIRF rank 43</h3><p style="font-size: 14px; color: #94a3b8; margin: 0;">Engineering, 2026</p></div>
      <div style="${CARD} padding: 22px;"><h3 style="font-size: 17px; font-weight: 800; margin: 0 0 8px;">NAAC A++</h3><p style="font-size: 14px; color: #94a3b8; margin: 0;">Reaccredited 2025, CGPA 3.71</p></div>
      <div style="${CARD} padding: 22px;"><h3 style="font-size: 17px; font-weight: 800; margin: 0 0 8px;">Smart India Hackathon</h3><p style="font-size: 14px; color: #94a3b8; margin: 0;">National winners, 2024 and 2026</p></div>
      <div style="${CARD} padding: 22px;"><h3 style="font-size: 17px; font-weight: 800; margin: 0 0 8px;">Inter-university athletics</h3><p style="font-size: 14px; color: #94a3b8; margin: 0;">Overall champions, three years running</p></div>
    </div>
  </div>
</section>`,
  },

  faq: {
    title: "Frequently Asked Questions",
    code: `<section style="background: #0f172a; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER} max-width: 900px;">
    <div style="text-align: center; margin-bottom: 48px;">
      <p style="${EYEBROW}">Got Questions?</p>
      <h2 style="${H2}">Frequently Asked Questions</h2>
      <p style="${LEAD}">Find quick answers to common questions about admissions, courses, campus facilities, and student life.</p>
    </div>
    <div style="display: flex; flex-direction: column; gap: 16px;">
      <details style="${CARD} cursor: pointer;" open>
        <summary style="font-size: 18px; font-weight: 800; color: #ffffff; outline: none; list-style: none; display: flex; justify-content: space-between; align-items: center;">
          <span>What is the application deadline for 2027 admissions?</span>
          <span style="font-size: 20px; color: #60a5fa; margin-left: 12px;">▾</span>
        </summary>
        <p style="${LEAD} margin-top: 14px; font-size: 15px; color: #94a3b8;">Applications for the 2027 academic intake close on 15 January. Late applications may be considered subject to seat availability.</p>
      </details>
      <details style="${CARD} cursor: pointer;">
        <summary style="font-size: 18px; font-weight: 800; color: #ffffff; outline: none; list-style: none; display: flex; justify-content: space-between; align-items: center;">
          <span>Are scholarships available for undergraduate students?</span>
          <span style="font-size: 20px; color: #60a5fa; margin-left: 12px;">▾</span>
        </summary>
        <p style="${LEAD} margin-top: 14px; font-size: 15px; color: #94a3b8;">Yes, merit-based and need-based scholarships are offered covering up to 100% of tuition fees for qualifying students.</p>
      </details>
      <details style="${CARD} cursor: pointer;">
        <summary style="font-size: 18px; font-weight: 800; color: #ffffff; outline: none; list-style: none; display: flex; justify-content: space-between; align-items: center;">
          <span>What hostel and accommodation facilities are provided?</span>
          <span style="font-size: 20px; color: #60a5fa; margin-left: 12px;">▾</span>
        </summary>
        <p style="${LEAD} margin-top: 14px; font-size: 15px; color: #94a3b8;">We provide separate modern residential halls for male and female students with 24/7 security, high-speed Wi-Fi, dining, and recreation areas.</p>
      </details>
      <details style="${CARD} cursor: pointer;">
        <summary style="font-size: 18px; font-weight: 800; color: #ffffff; outline: none; list-style: none; display: flex; justify-content: space-between; align-items: center;">
          <span>How does the campus placement assistance work?</span>
          <span style="font-size: 20px; color: #60a5fa; margin-left: 12px;">▾</span>
        </summary>
        <p style="${LEAD} margin-top: 14px; font-size: 15px; color: #94a3b8;">Our dedicated Career Development Cell organizes pre-placement training, mock interviews, and hosts 200+ top recruiters every year.</p>
      </details>
    </div>
  </div>
</section>`,
  },

  contact: {
    title: "Contact / Enquiry Form",
    code: `<section style="background: #0d1527; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER} display: grid; grid-template-columns: repeat(2, 1fr); gap: 48px;">
    <div>
      <p style="${EYEBROW}">Get in touch</p>
      <h2 style="${H2}">Admissions helpdesk</h2>
      <p style="${LEAD} margin-bottom: 22px;">Open Monday to Saturday, 09:00 to 17:00. We answer email within one working day.</p>
      <p style="font-size: 15px; line-height: 2; color: #cbd5e1; margin: 0;">
        Greenfield University, Ring Road, Coimbatore 641014<br />
        <a href="tel:+914223456789" style="color: #ffffff; text-decoration: none; font-weight: 700;">+91 422 345 6789</a><br />
        <a href="mailto:admissions@greenfield.edu" style="color: #ffffff; text-decoration: none; font-weight: 700;">admissions@greenfield.edu</a>
      </p>
    </div>
    <form style="${CARD} display: grid; gap: 14px;">
      <label style="font-size: 12px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: #94a3b8;">Full name</label>
      <input type="text" placeholder="Your name" style="padding: 13px 15px; border: 1px solid rgba(255,255,255,0.14); border-radius: 10px; background: #0f172a; color: #ffffff; font-size: 15px;" />
      <label style="font-size: 12px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: #94a3b8;">Email</label>
      <input type="email" placeholder="you@example.com" style="padding: 13px 15px; border: 1px solid rgba(255,255,255,0.14); border-radius: 10px; background: #0f172a; color: #ffffff; font-size: 15px;" />
      <label style="font-size: 12px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: #94a3b8;">Your question</label>
      <textarea rows="4" placeholder="Ask us anything about admission" style="padding: 13px 15px; border: 1px solid rgba(255,255,255,0.14); border-radius: 10px; background: #0f172a; color: #ffffff; font-size: 15px;"></textarea>
      <button type="button" style="padding: 14px 28px; border: none; border-radius: 999px; background: #2563eb; color: #ffffff; font-size: 14px; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;">Send enquiry</button>
    </form>
  </div>
</section>`,
  },

  map: {
    title: "Map & Location",
    code: `<section style="background: #0f172a; color: #ffffff; ${SECTION}">
  <div style="${CONTAINER} display: grid; grid-template-columns: repeat(2, 1fr); gap: 48px; align-items: center;">
    <div>
      <p style="${EYEBROW}">Finding us</p>
      <h2 style="${H2}">Ring Road, Coimbatore</h2>
      <p style="${LEAD} margin-bottom: 20px;">Fourteen kilometres from the airport and four from the junction railway station. Campus buses meet every intercity arrival during admission week.</p>
      <a href="https://maps.google.com/?q=Coimbatore" target="_blank" style="display: inline-block; background: #2563eb; color: #ffffff; padding: 13px 30px; border-radius: 12px; font-size: 14px; font-weight: 800; text-decoration: none;">Open directions</a>
    </div>
    <div style="${CARD} padding: 0; overflow: hidden;">
      <div style="height: 300px; background: #1e293b; display: flex; align-items: center; justify-content: center; text-align: center; padding: 24px;">
        <div>
          <div style="font-size: 15px; font-weight: 800; color: #ffffff;">Campus map</div>
          <p style="font-size: 13px; color: #94a3b8; margin: 8px 0 0;">Drop an image of the campus map here, or link out to directions.</p>
        </div>
      </div>
    </div>
  </div>
</section>`,
  },

  footer: {
    title: "Footer",
    code: `<footer style="background: #090d16; color: #94a3b8; padding: 56px 40px 32px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box; border-top: 1px solid #1e293b;">
  <div style="${CONTAINER} display: grid; grid-template-columns: repeat(4, 1fr); gap: 32px;">
    <div>
      <div style="font-size: 17px; font-weight: 900; color: #cbd5e1;">GREENFIELD UNIVERSITY</div>
      <p style="font-size: 14px; line-height: 1.8; margin: 12px 0 0;">Ring Road, Coimbatore 641014<br />Tamil Nadu, India</p>
    </div>
    <div>
      <div style="font-size: 12px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: #cbd5e1; margin-bottom: 12px;">Study</div>
      <ul style="list-style: none; margin: 0; padding: 0; font-size: 14px; line-height: 2;"><li><a href="#courses" style="color: #94a3b8; text-decoration: none;">Programmes</a></li><li><a href="#admissions" style="color: #94a3b8; text-decoration: none;">Admissions</a></li><li><a href="#fees" style="color: #94a3b8; text-decoration: none;">Fees &amp; scholarships</a></li></ul>
    </div>
    <div>
      <div style="font-size: 12px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: #cbd5e1; margin-bottom: 12px;">Campus</div>
      <ul style="list-style: none; margin: 0; padding: 0; font-size: 14px; line-height: 2;"><li><a href="#facilities" style="color: #94a3b8; text-decoration: none;">Facilities</a></li><li><a href="#events" style="color: #94a3b8; text-decoration: none;">Events</a></li><li><a href="#gallery" style="color: #94a3b8; text-decoration: none;">Gallery</a></li></ul>
    </div>
    <div>
      <div style="font-size: 12px; font-weight: 800; letter-spacing: 0.14em; text-transform: uppercase; color: #cbd5e1; margin-bottom: 12px;">Connect</div>
      <ul style="list-style: none; margin: 0; padding: 0; font-size: 14px; line-height: 2;"><li><a href="#news" style="color: #94a3b8; text-decoration: none;">News</a></li><li><a href="#contact" style="color: #94a3b8; text-decoration: none;">Contact</a></li><li><a href="#alumni" style="color: #94a3b8; text-decoration: none;">Alumni</a></li></ul>
    </div>
  </div>
  <div style="${CONTAINER} margin-top: 36px; padding-top: 20px; border-top: 1px solid #1e293b; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; font-size: 13px;">
    <span style="color: #cbd5e1; font-weight: 700;">&copy; 2026 Greenfield University. All rights reserved.</span>
    <span>Approved by AICTE &amp; UGC &middot; Accredited NAAC A++</span>
  </div>
</footer>`,
  },
};

/**
 * The starters in canonical order — the order a page is built in.
 *
 * Canonical order is not alphabetical and not arbitrary: it is the order a
 * college website is read in, navbar first and footer last, which is why
 * `SECTION_CATEGORY_IDS` is written the way it is. Deriving the sequence from
 * that list rather than from `Object.keys` keeps the two from disagreeing —
 * object key order is insertion order, which is one careless edit away from
 * putting the footer in the middle of every tenant's page.
 */
export function startersInCanonicalOrder(): Array<{ category: SectionCategoryId } & SectionStarter> {
  return SECTION_CATEGORY_IDS.map((category) => ({ category, ...SECTION_STARTERS[category] }));
}
