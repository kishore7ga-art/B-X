import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { createPool } from "@/lib/db-pool";

/**
 * One pool, one client, for the life of the process.
 *
 * Same cloud-tuned pool the frontend uses — capped connections, keepalive, and
 * an idle-error handler so a provider recycling a socket does not take the
 * process down with it.
 */
export const pool = createPool();
export const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
