-- Backfill: give every provisioned college the full default page list.
--
-- `DEFAULT_PAGES` (src/lib/site/starter.ts, shared with xite-F) grew from four
-- pages to twelve. Provisioning only ever created pages for a college that had
-- none, so colleges created before that change kept their original four while
-- both the editor's page switcher and the public site's header listed all
-- twelve. The eight without a row behind them were links to a 404: the editor
-- endpoint answers 404 for an unknown slug, and /site/<sub>/<slug> calls
-- notFound(). This creates the rows those links already promised.
--
-- The list is written out as data rather than read from the TypeScript: a
-- migration is a record of what the database was asked to do on one date. A
-- later change to the starter list is a later migration, not a silent
-- re-interpretation of this one.
--
-- Idempotent. ON CONFLICT leans on the (college_id, slug) unique index, so a
-- page a college already has — including one whose title it has since edited —
-- is left exactly as it is.

-- Dropped first rather than relying on ON COMMIT DROP: whether this file runs
-- inside one transaction is the migration runner's business, and a leftover temp
-- table from an earlier run in the same session should not be the thing that
-- fails a deploy.
DROP TABLE IF EXISTS default_pages;

CREATE TEMP TABLE default_pages (slug text, title text, nav_order int);

INSERT INTO default_pages VALUES
  ('home',       'Home',                     0),
  ('about',      'About Us',                 1),
  ('academics',  'Academics',                2),
  ('courses',    'Courses & Programs',       3),
  ('admissions', 'Admissions & Eligibility', 4),
  ('placements', 'Placements & Career',      5),
  ('facilities', 'Campus & Facilities',      6),
  ('research',   'Research & Innovation',    7),
  ('events',     'Events & News',            8),
  ('faculty',    'Faculty',                  9),
  ('alumni',     'Alumni Network',          10),
  ('contact',    'Contact Us',              11);

-- Colleges still holding exactly the old starter set, in its original order.
-- These can take the new twelve-page order as designed, because there is no
-- editing of their own to preserve. Anything else — a college that added,
-- removed or reordered a page — keeps the order it has.
DROP TABLE IF EXISTS untouched_colleges;

CREATE TEMP TABLE untouched_colleges AS
SELECT c.id
FROM colleges c
WHERE (SELECT count(*) FROM pages p WHERE p.college_id = c.id) = 4
  AND NOT EXISTS (
    SELECT 1
    FROM pages p
    WHERE p.college_id = c.id
      AND (p.slug, p.nav_order) NOT IN
          (('home', 0), ('about', 1), ('admissions', 2), ('contact', 3))
  );

UPDATE pages p
SET nav_order = d.nav_order
FROM default_pages d
WHERE p.slug = d.slug
  AND p.college_id IN (SELECT id FROM untouched_colleges);

INSERT INTO pages (id, college_id, slug, title, nav_order)
SELECT gen_random_uuid()::text, uc.id, d.slug, d.title, d.nav_order
FROM untouched_colleges uc
CROSS JOIN default_pages d
ON CONFLICT (college_id, slug) DO NOTHING;

-- Every other provisioned college: append what is missing after its current
-- last page, in the default list's own order. Appending rather than inserting at
-- the designed position is what keeps two pages from landing on the same
-- nav_order, which would make the header's order arbitrary.
--
-- A college with no pages at all is skipped: it has not picked a template yet,
-- and provisioning creates the full set when it does. Pre-creating them here
-- would put a site's worth of pages behind an account that has not started one.
INSERT INTO pages (id, college_id, slug, title, nav_order)
SELECT
  gen_random_uuid()::text,
  missing.college_id,
  missing.slug,
  missing.title,
  missing.last_order
    + row_number() OVER (PARTITION BY missing.college_id ORDER BY missing.nav_order)
FROM (
  SELECT
    c.id AS college_id,
    d.slug,
    d.title,
    d.nav_order,
    (SELECT max(p.nav_order) FROM pages p WHERE p.college_id = c.id) AS last_order
  FROM colleges c
  CROSS JOIN default_pages d
  WHERE EXISTS (SELECT 1 FROM pages p WHERE p.college_id = c.id)
    AND c.id NOT IN (SELECT id FROM untouched_colleges)
    AND NOT EXISTS (
      SELECT 1 FROM pages p WHERE p.college_id = c.id AND p.slug = d.slug
    )
) AS missing
ON CONFLICT (college_id, slug) DO NOTHING;
