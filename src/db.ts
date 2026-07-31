import { PrismaClient } from "@/generated/prisma/client";

/**
 * Singleton PrismaClient for MongoDB.
 */
export const prisma = new PrismaClient();
