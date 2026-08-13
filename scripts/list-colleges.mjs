import "dotenv/config";
import dns from "node:dns";
import mongoose from "mongoose";

try {
  dns.setDefaultResultOrder("ipv4first");
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (e) {}

async function listColleges() {
  const uri = process.env.MONGODB_URI;
  await mongoose.connect(uri);

  const db = mongoose.connection.db;
  const colleges = await db.collection("colleges").find({}).project({ name: 1, subdomain: 1, status: 1 }).toArray();

  console.log("COLLEGES:", JSON.stringify(colleges, null, 2));
  await mongoose.disconnect();
}

listColleges().catch(console.error);
