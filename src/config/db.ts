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
export async function connectDB(retries = 5, delayMs = 3000): Promise<typeof mongoose> {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    console.error("[db] FATAL: MONGODB_URI environment variable is missing.");
    process.exit(1);
  }

  mongoose.set("strictQuery", false);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[db] Connecting to MongoDB Atlas (Attempt ${attempt}/${retries})...`);
      const conn = await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 10000,
        connectTimeoutMS: 10000,
      });

      console.log(`[db] MongoDB Atlas Connected: ${conn.connection.host} / ${conn.connection.name}`);
      return conn;
    } catch (error) {
      console.error(`[db] Connection attempt ${attempt} failed:`, (error as Error).message);

      if (attempt === retries) {
        console.error("[db] WARNING: Remote Atlas cluster connection timed out or unreachable.");
        console.error("[db] Attempting local MongoDB fallback...");
        try {
          const localUri = "mongodb://127.0.0.1:27017/college_saas";
          const conn = await mongoose.connect(localUri);
          console.log(`[db] Local MongoDB Connected: ${conn.connection.host} / ${conn.connection.name}`);
          return conn;
        } catch (localErr) {
          console.error("[db] Local MongoDB connection also failed:", (localErr as Error).message);
          return mongoose;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw new Error("Could not connect to MongoDB Atlas");
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
