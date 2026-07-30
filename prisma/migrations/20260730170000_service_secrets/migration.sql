-- Somewhere for a key this service generated for itself.
--
-- ADMIN_SESSION_SECRET was a hard requirement, and a deployment that had not set
-- it answered 503 on every admin route — including the status endpoint the login
-- screen reads to explain itself. The panel now mints its own key on first use
-- and keeps it here, so sessions survive a restart instead of signing every
-- admin out on deploy. The environment variable still takes precedence, and
-- SESSION_SECRET is still never reused.

CREATE TABLE "service_secrets" (
  "name" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "service_secrets_pkey" PRIMARY KEY ("name")
);
