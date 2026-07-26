-- CreateTable
CREATE TABLE "college_sections_history" (
    "id" TEXT NOT NULL,
    "college_section_id" TEXT NOT NULL,
    "content_snapshot" JSONB NOT NULL,
    "saved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "save_trigger" TEXT NOT NULL,

    CONSTRAINT "college_sections_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "college_sections_history_college_section_id_saved_at_idx" ON "college_sections_history"("college_section_id", "saved_at");

-- AddForeignKey
ALTER TABLE "college_sections_history" ADD CONSTRAINT "college_sections_history_college_section_id_fkey" FOREIGN KEY ("college_section_id") REFERENCES "college_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
