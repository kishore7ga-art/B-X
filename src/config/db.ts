import mongoose from "mongoose";
import dns from "node:dns";

// Fix Node.js Windows SRV lookup for MongoDB Atlas
try {
  dns.setDefaultResultOrder("ipv4first");
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (e) {
  // Ignore fallback if custom DNS setting fails
}

/**
 * MongoDB Atlas Connection Manager with retry logic and lifecycle handling.
 */
export async function connectDB(retries = 8, delayMs = 5000): Promise<typeof mongoose> {
  // Accept both common env var names
  const uri = process.env.MONGODB_URI || process.env.DATABASE_URL;

  if (!uri) {
    console.error("[db] FATAL: Neither MONGODB_URI nor DATABASE_URL environment variable is set.");
    console.error("[db] Please set MONGODB_URI in Dokploy environment variables.");
    process.exit(1);
  }

  console.log("[db] Using URI starting with:", uri.slice(0, 30) + "...");
  mongoose.set("strictQuery", false);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[db] Connecting to MongoDB Atlas (Attempt ${attempt}/${retries})...`);
      const conn = await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 15000,
        socketTimeoutMS: 30000,
      });

      console.log(`[db] ✅ MongoDB Atlas Connected: ${conn.connection.host} / ${conn.connection.name}`);
      return conn;
    } catch (error) {
      console.error(`[db] ❌ Connection attempt ${attempt} failed:`, (error as Error).message);

      if (attempt === retries) {
        console.error("[db] ❌ FATAL: Could not connect to MongoDB Atlas after", retries, "attempts.");
        console.error("[db] ❌ Check: 1) MONGODB_URI env var in Dokploy  2) Atlas Network Access (whitelist 0.0.0.0/0)");
        // Don't exit — let the server run (health will show degraded) so logs are accessible
        return mongoose;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return mongoose;
}


mongoose.connection.on("disconnected", () => {
  console.warn("[db] MongoDB connection lost.");
});

mongoose.connection.on("reconnected", () => {
  console.log("[db] MongoDB reconnected successfully.");
});

mongoose.connection.on("error", (err) => {
  console.error("[db] MongoDB connection error:", err.message);
});
