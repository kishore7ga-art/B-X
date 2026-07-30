-- Turns the per-template variant duplication into one shared section library.
--
-- Written by hand rather than generated. `prisma migrate dev` produces the right
-- shape and the wrong order for this: it drops `section_id` and adds a required
-- `section_type` with nothing in between, so the mapping from variant to type is
-- gone before anything can read it, and the unique index on `component_key` lands
-- on a table that still holds five rows per key. It said so and refused, which is
-- the correct answer to being asked.
--
-- Read in order. Steps 3 and 5 both depend on `section_id` still existing, which
-- is why the drop is last.

-- ---------------------------------------------------------------------------
-- 1. New section types.
--
-- Added, not replaced. The guide's enum has nine values and overlaps this one on
-- five; adopting it wholesale would mean migrating 25 `sections` rows, 89
-- `college_sections` rows, `registry.tsx` and `schemas.ts` to lose ten types that
-- are in use. HEADER/FEATURES/CTA were simply missing. CUSTOM is the pasted-markup
-- escape hatch and the only type a sanitiser applies to.
--
-- Safe inside the migration transaction because nothing below inserts a row using
-- one of these — Postgres permits ADD VALUE in a transaction but not its use in
-- the same one.
-- ---------------------------------------------------------------------------
ALTER TYPE "SectionType" ADD VALUE 'HEADER';
ALTER TYPE "SectionType" ADD VALUE 'FEATURES';
ALTER TYPE "SectionType" ADD VALUE 'CTA';
ALTER TYPE "SectionType" ADD VALUE 'CUSTOM';

-- ---------------------------------------------------------------------------
-- 2. New columns, all nullable or defaulted so existing rows stay valid.
-- ---------------------------------------------------------------------------
ALTER TABLE "section_variants"
  ADD COLUMN "section_type"     "SectionType",
  ADD COLUMN "is_active"        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "default_html"     TEXT,
  ADD COLUMN "created_by_id"    TEXT,
  ADD COLUMN "created_by_email" TEXT,
  ADD COLUMN "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "updated_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "sections"
  ADD COLUMN "default_variant_id" TEXT;

ALTER TABLE "templates"
  ADD COLUMN "is_published"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "created_by_id"    TEXT,
  ADD COLUMN "created_by_email" TEXT,
  ADD COLUMN "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- The five templates that already exist are live and being used by seven
-- colleges. A flag added underneath them defaults to false, which would retire
-- every one of them from the gallery on deploy.
UPDATE "templates" SET "is_published" = true;

-- ---------------------------------------------------------------------------
-- 3. Backfill each variant's type from the slot it currently belongs to.
--    Requires section_id.
-- ---------------------------------------------------------------------------
UPDATE "section_variants" v
SET "section_type" = s."section_type"
FROM "sections" s
WHERE v."section_id" = s."id";

-- ---------------------------------------------------------------------------
-- 4. Record which variant each template slot leads with, BEFORE the library is
--    collapsed.
--
--    This is the whole reason the five templates do not flatten into one look.
--    `sort_order` carried this per-slot; once rows are shared it is global, so the
--    choice has to be captured here while it is still per-template. The rule below
--    is the same one the application already used to pick a lead: lowest
--    sort_order, then name.
-- ---------------------------------------------------------------------------
UPDATE "sections" s
SET "default_variant_id" = (
  SELECT v."id"
  FROM "section_variants" v
  WHERE v."section_id" = s."id"
  ORDER BY v."sort_order" ASC, v."variant_name" ASC
  LIMIT 1
);

-- ---------------------------------------------------------------------------
-- 5. Collapse duplicates.
--
--    One canonical row per component_key — the lowest id, which for cuids is the
--    earliest inserted and is deterministic. Everything pointing at a duplicate is
--    re-pointed at the canonical row first; only then are the duplicates deleted.
--    Doing it the other way round would take 89 live college sections with it.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE "variant_canonical" AS
SELECT
  v."id" AS old_id,
  (
    SELECT v2."id"
    FROM "section_variants" v2
    WHERE v2."component_key" = v."component_key"
    ORDER BY v2."id" ASC
    LIMIT 1
  ) AS new_id
FROM "section_variants" v;

-- The surviving row keeps the tightest order any of its copies had, so the
-- picker's sequence is not reshuffled by which duplicate happened to win.
UPDATE "section_variants" v
SET "sort_order" = agg.min_order
FROM (
  SELECT "component_key", MIN("sort_order") AS min_order
  FROM "section_variants"
  GROUP BY "component_key"
) agg
WHERE v."component_key" = agg."component_key";

UPDATE "college_sections" cs
SET "variant_id" = vc.new_id
FROM "variant_canonical" vc
WHERE cs."variant_id" = vc.old_id
  AND vc.new_id <> vc.old_id;

UPDATE "sections" s
SET "default_variant_id" = vc.new_id
FROM "variant_canonical" vc
WHERE s."default_variant_id" = vc.old_id
  AND vc.new_id <> vc.old_id;

DELETE FROM "section_variants" v
USING "variant_canonical" vc
WHERE v."id" = vc.old_id
  AND vc.new_id <> vc.old_id;

DROP TABLE "variant_canonical";

-- ---------------------------------------------------------------------------
-- 6. Now that every row has a type and there is one row per key, tighten up.
--    Dropping section_id also drops its foreign key and the
--    (section_id, component_key) unique index that depended on it.
-- ---------------------------------------------------------------------------
ALTER TABLE "section_variants" ALTER COLUMN "section_type" SET NOT NULL;
ALTER TABLE "section_variants" DROP COLUMN "section_id";

CREATE UNIQUE INDEX "section_variants_component_key_key"
  ON "section_variants"("component_key");
CREATE INDEX "section_variants_section_type_is_active_idx"
  ON "section_variants"("section_type", "is_active");
CREATE INDEX "templates_is_published_archived_at_idx"
  ON "templates"("is_published", "archived_at");

-- ---------------------------------------------------------------------------
-- 7. Foreign keys.
--
--    SetNull throughout: losing an admin account must not delete the designs they
--    added, and retiring a variant must not take a template slot with it. The
--    copied `created_by_email` is what keeps the record readable afterwards.
-- ---------------------------------------------------------------------------
ALTER TABLE "section_variants"
  ADD CONSTRAINT "section_variants_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "templates"
  ADD CONSTRAINT "templates_created_by_id_fkey"
  FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sections"
  ADD CONSTRAINT "sections_default_variant_id_fkey"
  FOREIGN KEY ("default_variant_id") REFERENCES "section_variants"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
