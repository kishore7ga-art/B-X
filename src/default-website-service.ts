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

// Initial default website structure with clean pages
const INITIAL_DEFAULT_WEBSITE: DefaultWebsiteConfig = {
  pages: [
    { slug: "/home", title: "Home", sections: [] },
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
