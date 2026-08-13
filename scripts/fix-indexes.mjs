import "dotenv/config";
import dns from "node:dns";
import mongoose from "mongoose";

try {
  dns.setDefaultResultOrder("ipv4first");
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (e) {}

async function fixIndexes() {
  const uri = process.env.MONGODB_URI;
  console.log("Connecting to MongoDB Atlas to fix indexes...");
  await mongoose.connect(uri);

  const db = mongoose.connection.db;
  const collegesCollection = db.collection("colleges");

  try {
    const indexes = await collegesCollection.indexes();
    console.log("Existing indexes on colleges:", indexes.map(i => i.name));

    if (indexes.some(i => i.name === "customDomain_1")) {
      await collegesCollection.dropIndex("customDomain_1");
      console.log("Successfully dropped customDomain_1 index!");
    }
  } catch (err) {
    console.log("Index drop info:", err.message);
  }

  // Also clean up any existing documents that have customDomain set to null
  const updateResult = await collegesCollection.updateMany(
    { customDomain: null },
    { $unset: { customDomain: "" } }
  );
  console.log(`Unset customDomain: null on ${updateResult.modifiedCount} documents.`);

  await mongoose.disconnect();
  console.log("Done!");
}

fixIndexes().catch((err) => {
  console.error("Failed to fix indexes:", err);
  process.exit(1);
});
