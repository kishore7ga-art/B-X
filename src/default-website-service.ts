import { SystemSecret, AuditLog } from "@/models";

export type DefaultWebsiteSection = {
  id: string;
  title: string;
  sectionType: string;
  code: string;
  sortOrder: number;
};

export type DefaultWebsitePage = {
  slug: string;
  title: string;
  sections: DefaultWebsiteSection[];
};

export type DefaultWebsiteConfig = {
  pages: DefaultWebsitePage[];
};

// Initial default website structure containing strictly Header and Footer
export const HEADER_SECTION_CODE = `<header style="background: #0d1527; color: #ffffff; padding: 18px 40px; display: flex; align-items: center; justify-content: space-between; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box; border-bottom: 1px solid rgba(255,255,255,0.1); position: relative;">
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
</header>`;

export const FOOTER_SECTION_CODE = `<footer style="background: #090d16; color: #94a3b8; padding: 40px 40px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box; border-top: 1px solid #1e293b; text-align: center;">
  <p style="font-size: 13px; font-weight: 700; color: #cbd5e1; margin: 0;">© 2026 Greenfield University. All Rights Reserved.</p>
  <p style="font-size: 12px; color: #64748b; margin-top: 8px;">Approved by AICTE, UGC & Accredited by NAAC A++ Grade.</p>
</footer>`;

const INITIAL_DEFAULT_WEBSITE: DefaultWebsiteConfig = {
  pages: [
    {
      slug: "/home",
      title: "Home",
      sections: [
        {
          id: "def-home-navbar",
          title: "Navbar / Header",
          sectionType: "navbar",
          sortOrder: 0,
          code: HEADER_SECTION_CODE,
        },
        {
          id: "def-home-footer",
          title: "Footer",
          sectionType: "footer",
          sortOrder: 1,
          code: FOOTER_SECTION_CODE,
        },
      ],
    },
    { slug: "/about", title: "About Us", sections: [] },
    { slug: "/academics", title: "Academics", sections: [] },
    { slug: "/placements", title: "Placements", sections: [] },
    { slug: "/contact", title: "Contact Us", sections: [] },
  ],
};

/** Ensure system_secrets collection holds default website config with clean sections and pages */
export async function getDefaultWebsiteConfig(): Promise<DefaultWebsiteConfig> {
  try {
    const secret = await SystemSecret.findOne({ name: "DEFAULT_WEBSITE_CONFIG" });
    if (secret && secret.value) {
      const parsed = typeof secret.value === "string" ? JSON.parse(secret.value) : secret.value;
      if (parsed && Array.isArray(parsed.pages) && parsed.pages.length > 0) {
        const existingSlugs = new Set(parsed.pages.map((p: any) => p.slug));
        const mergedPages = [...parsed.pages];
        INITIAL_DEFAULT_WEBSITE.pages.forEach((initPage) => {
          if (!existingSlugs.has(initPage.slug)) {
            mergedPages.push(initPage);
          }
        });
        return { pages: mergedPages };
      }
    }
  } catch (err) {
    console.error("Error reading default website config from MongoDB:", err);
  }

  // Force seed database if record missing
  try {
    await updateDefaultWebsiteConfig(INITIAL_DEFAULT_WEBSITE);
  } catch {}

  return INITIAL_DEFAULT_WEBSITE;
}

export async function updateDefaultWebsiteConfig(
  config: DefaultWebsiteConfig
): Promise<DefaultWebsiteConfig> {
  await SystemSecret.findOneAndUpdate(
    { name: "DEFAULT_WEBSITE_CONFIG" },
    { name: "DEFAULT_WEBSITE_CONFIG", value: config },
    { upsert: true, new: true }
  );

  await AuditLog.create({
    action: "EDITOR_CONFIG_UPDATED",
    tenantId: "system",
    details: { pagesCount: config.pages?.length || 0 },
  }).catch(() => null);

  return config;
}
