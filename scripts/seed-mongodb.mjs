import { connectDb } from "../src/db.js";
import { Template } from "../src/models.js";
import { getDefaultWebsiteConfig, updateDefaultWebsiteConfig } from "../src/default-website-service.js";

async function seed() {
  console.log("[seed] Connecting to database...");
  await connectDb();

  const count = await Template.countDocuments();
  if (count === 0) {
    console.log("[seed] Populating default templates into MongoDB...");
    await Template.create([
      {
        id: "reference-university-v1",
        name: "Greenfield University Standard",
        category: "University",
        description: "Official comprehensive university landing page template with all 19 standard sections.",
        isPublished: true,
        createdByEmail: "admin@xite.co.in",
        createdAt: new Date(),
      },
      {
        id: "modern-engineering-v2",
        name: "Madras Engineering College",
        category: "Engineering",
        description: "High-impact tech & placement-focused engineering campus template.",
        isPublished: true,
        createdByEmail: "admin@xite.co.in",
        createdAt: new Date(),
      },
      {
        id: "arts-science-v1",
        name: "Royal Arts & Science College",
        category: "Arts & Science",
        description: "Elegant academic & research portal template for liberal arts and science colleges.",
        isPublished: true,
        createdByEmail: "admin@xite.co.in",
        createdAt: new Date(),
      },
    ]);
    console.log("[seed] 3 default templates created.");
  }

  // Ensure default website configuration is initialized in DB
  const def = await getDefaultWebsiteConfig();
  if (def && Array.isArray(def.pages) && def.pages.length > 0) {
    await updateDefaultWebsiteConfig(def);
    console.log("[seed] Default website configuration persisted to DB.");
  }

  console.log("[seed] Seeding completed successfully.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("[seed] Seeding error:", err);
  process.exit(0);
});
