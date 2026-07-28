-- An orphaned college must not be inherited by the next stranger to sign up.
ALTER TABLE "colleges" ADD COLUMN "adoptable" BOOLEAN NOT NULL DEFAULT true;

-- Retiring a template, rather than deleting it. A DELETE cascades through
-- sections into college_sections and would take the content of every college
-- using that template with it.
ALTER TABLE "templates" ADD COLUMN "archived_at" TIMESTAMP(3);

CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "totp_secret" TEXT,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_email" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");
CREATE INDEX "audit_log_target_type_target_id_idx" ON "audit_log"("target_type", "target_id");

-- SetNull, not Cascade: losing the admin account must never take the record of
-- what it did with it.
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "admin_users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
