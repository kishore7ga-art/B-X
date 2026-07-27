-- AlterTable
ALTER TABLE "pages" ADD COLUMN     "canonical_slug" TEXT,
ADD COLUMN     "meta_description" TEXT,
ADD COLUMN     "meta_title" TEXT,
ADD COLUMN     "og_image" TEXT;
