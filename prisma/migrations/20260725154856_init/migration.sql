-- CreateEnum
CREATE TYPE "CollegeStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "SectionType" AS ENUM ('HERO', 'ABOUT', 'COURSES', 'ADMISSIONS', 'FACULTY', 'FACILITIES', 'GALLERY', 'EVENTS', 'CONTACT', 'FOOTER', 'PLACEMENTS', 'TESTIMONIALS', 'DOWNLOADS', 'FEES', 'ACCREDITATION');

-- CreateTable
CREATE TABLE "colleges" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "custom_domain" TEXT,
    "template_id" TEXT,
    "theme_palette_id" TEXT,
    "theme_font_id" TEXT,
    "status" "CollegeStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "colleges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "thumbnail_url" TEXT,
    "demo_url" TEXT,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sections" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "section_type" "SectionType" NOT NULL,
    "default_order" INTEGER NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_variants" (
    "id" TEXT NOT NULL,
    "section_id" TEXT NOT NULL,
    "variant_name" TEXT NOT NULL,
    "component_key" TEXT NOT NULL,

    CONSTRAINT "section_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "college_sections" (
    "id" TEXT NOT NULL,
    "college_id" TEXT NOT NULL,
    "section_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "page_id" TEXT,
    "display_order" INTEGER NOT NULL,
    "is_visible" BOOLEAN NOT NULL DEFAULT true,
    "content" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "college_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "theme_palettes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "colors" JSONB NOT NULL,

    CONSTRAINT "theme_palettes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "theme_fonts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "heading_font" TEXT NOT NULL,
    "body_font" TEXT NOT NULL,

    CONSTRAINT "theme_fonts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pages" (
    "id" TEXT NOT NULL,
    "college_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "nav_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "colleges_subdomain_key" ON "colleges"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "colleges_custom_domain_key" ON "colleges"("custom_domain");

-- CreateIndex
CREATE UNIQUE INDEX "templates_name_key" ON "templates"("name");

-- CreateIndex
CREATE UNIQUE INDEX "sections_template_id_section_type_key" ON "sections"("template_id", "section_type");

-- CreateIndex
CREATE UNIQUE INDEX "section_variants_section_id_component_key_key" ON "section_variants"("section_id", "component_key");

-- CreateIndex
CREATE INDEX "college_sections_college_id_page_id_display_order_idx" ON "college_sections"("college_id", "page_id", "display_order");

-- CreateIndex
CREATE UNIQUE INDEX "theme_palettes_name_key" ON "theme_palettes"("name");

-- CreateIndex
CREATE UNIQUE INDEX "theme_fonts_name_key" ON "theme_fonts"("name");

-- CreateIndex
CREATE UNIQUE INDEX "pages_college_id_slug_key" ON "pages"("college_id", "slug");

-- AddForeignKey
ALTER TABLE "colleges" ADD CONSTRAINT "colleges_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "colleges" ADD CONSTRAINT "colleges_theme_palette_id_fkey" FOREIGN KEY ("theme_palette_id") REFERENCES "theme_palettes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "colleges" ADD CONSTRAINT "colleges_theme_font_id_fkey" FOREIGN KEY ("theme_font_id") REFERENCES "theme_fonts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sections" ADD CONSTRAINT "sections_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_variants" ADD CONSTRAINT "section_variants_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "college_sections" ADD CONSTRAINT "college_sections_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "colleges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "college_sections" ADD CONSTRAINT "college_sections_section_id_fkey" FOREIGN KEY ("section_id") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "college_sections" ADD CONSTRAINT "college_sections_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "section_variants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "college_sections" ADD CONSTRAINT "college_sections_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pages" ADD CONSTRAINT "pages_college_id_fkey" FOREIGN KEY ("college_id") REFERENCES "colleges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
