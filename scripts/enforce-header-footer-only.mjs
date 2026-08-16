import mongoose from "mongoose";
import dns from "node:dns";

try {
  dns.setDefaultResultOrder("ipv4first");
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch (e) {}

const MONGODB_URI = "mongodb+srv://kishorehi007_db_user:bAWpadELrbNNzGPr@xitedb.uk7epss.mongodb.net/college_saas?retryWrites=true&w=majority&appName=xitedb";

const HEADER_SECTION = {
  id: "def-home-navbar",
  title: "Navbar / Header",
  sectionType: "navbar",
  sortOrder: 0,
  code: `<header style="background: #0d1527; color: #ffffff; padding: 18px 40px; display: flex; align-items: center; justify-content: space-between; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box; border-bottom: 1px solid rgba(255,255,255,0.1); position: relative;">
  <div style="display: flex; align-items: center; gap: 12px;">
    <div style="width: 40px; height: 40px; border-radius: 10px; background: #2563eb; color: #ffffff; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 18px;">🎓</div>
    <span style="font-size: 20px; font-weight: 900; color: #ffffff; white-space: nowrap;">GREENFIELD UNIVERSITY</span>
  </div>
  <nav style="display: flex; gap: 24px; font-size: 14px; font-weight: 700;">
    <a href="#about" style="color: #cbd5e1; text-decoration: none;">About</a>
    <a href="#courses" style="color: #cbd5e1; text-decoration: none;">Academics</a>
    <a href="#admissions" style="color: #cbd5e1; text-decoration: none;">Admissions</a>
    <a href="#contact" style="color: #cbd5e1; text-decoration: none;">Contact</a>
  </nav>
  <a href="#apply" style="background: #2563eb; color: #ffffff; padding: 10px 24px; border-radius: 10px; font-size: 13px; font-weight: 800; text-decoration: none;">Apply Now</a>
</header>`
};

const FOOTER_SECTION = {
  id: "def-home-footer",
  title: "Footer",
  sectionType: "footer",
  sortOrder: 1,
  code: `<footer style="background: #090d16; color: #94a3b8; padding: 40px 40px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box; border-top: 1px solid #1e293b; text-align: center;">
  <p style="font-size: 13px; font-weight: 700; color: #cbd5e1; margin: 0;">© 2026 Greenfield University. All Rights Reserved.</p>
  <p style="font-size: 12px; color: #64748b; margin-top: 8px;">Approved by AICTE, UGC & Accredited by NAAC A++ Grade.</p>
</footer>`
};

const STRICT_CONFIG = {
  pages: [
    {
      slug: "/home",
      title: "Home",
      sections: [HEADER_SECTION, FOOTER_SECTION]
    },
    { slug: "/about", title: "About Us", sections: [] },
    { slug: "/academics", title: "Academics", sections: [] },
    { slug: "/placements", title: "Placements", sections: [] },
    { slug: "/contact", title: "Contact Us", sections: [] }
  ]
};

async function enforceHeaderFooterOnly() {
  console.log("Connecting to MongoDB Atlas...");
  await mongoose.connect(MONGODB_URI);
  console.log("✓ Connected to MongoDB Atlas");

  const secretSchema = new mongoose.Schema({ name: String, value: mongoose.Schema.Types.Mixed });
  const collegeSchema = new mongoose.Schema({ name: String, websiteConfig: mongoose.Schema.Types.Mixed });

  const SystemSecret = mongoose.models.SystemSecret || mongoose.model("SystemSecret", secretSchema);
  const College = mongoose.models.College || mongoose.model("College", collegeSchema);

  // 1. Update DEFAULT_WEBSITE_CONFIG in SystemSecret
  await SystemSecret.findOneAndUpdate(
    { name: "DEFAULT_WEBSITE_CONFIG" },
    { name: "DEFAULT_WEBSITE_CONFIG", value: STRICT_CONFIG },
    { upsert: true, new: true }
  );
  console.log("✓ Successfully updated DEFAULT_WEBSITE_CONFIG in MongoDB Atlas to contain ONLY Header and Footer.");

  // 2. Update all existing colleges to have ONLY Header and Footer
  const colleges = await College.find();
  console.log(`Found ${colleges.length} college(s) in database. Updating website configs...`);

  for (const col of colleges) {
    col.websiteConfig = STRICT_CONFIG;
    await col.save();
    console.log(`✓ Updated college "${col.name}" websiteConfig to Header & Footer ONLY.`);
  }

  console.log("\n🎉 ALL COLLEGIES & DEFAULT WEBSITE SUCCESSFULLY RESTRICTED TO HEADER AND FOOTER ONLY!");
  await mongoose.disconnect();
  process.exit(0);
}

enforceHeaderFooterOnly().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
