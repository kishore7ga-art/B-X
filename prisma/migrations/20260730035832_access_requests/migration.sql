-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "access_requests" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "organization" TEXT,
    "message" TEXT,
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by_id" TEXT,
    "reviewed_by_email" TEXT,
    "invite_token_hash" TEXT,
    "invite_token_expires_at" TIMESTAMP(3),
    "created_user_id" TEXT,

    CONSTRAINT "access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "access_requests_invite_token_hash_key" ON "access_requests"("invite_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "access_requests_created_user_id_key" ON "access_requests"("created_user_id");

-- CreateIndex
CREATE INDEX "access_requests_email_idx" ON "access_requests"("email");

-- CreateIndex
CREATE INDEX "access_requests_status_created_at_idx" ON "access_requests"("status", "created_at");

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "admin_users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_requests" ADD CONSTRAINT "access_requests_created_user_id_fkey" FOREIGN KEY ("created_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
