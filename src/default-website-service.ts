import { pool } from "@/db";

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

// Rich initial default website structure across 5 primary pages
const INITIAL_DEFAULT_WEBSITE: DefaultWebsiteConfig = {
  pages: [
    {
      slug: "/home",
      title: "Home",
      sections: [
        {
          id: "def-home-hero",
          title: "Hero Banner",
          sectionType: "hero",
          sortOrder: 0,
          code: `<section style="background: #000000; color: #ffffff; padding: 100px 24px; text-align: center; font-family: system-ui, -apple-system, sans-serif; width: 100%; box-sizing: border-box; position: relative;">
  <div style="max-width: 950px; margin: 0 auto;">
    <span style="background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.2); padding: 6px 22px; border-radius: 9999px; font-size: 12px; font-weight: 800; color: #ffffff; letter-spacing: 0.12em; text-transform: uppercase;">
      Official Campus Portal
    </span>
    <h1 style="font-size: 54px; font-weight: 900; margin-top: 24px; line-height: 1.1; color: #ffffff; letter-spacing: -0.03em;">
      Excellence in Higher Education & Innovation
    </h1>
    <p style="font-size: 18px; color: #a1a1aa; margin-top: 20px; line-height: 1.6; max-width: 720px; margin-left: auto; margin-right: auto;">
      Empowering minds, advancing research, and building leaders for tomorrow's challenges with world-class academic programs.
    </p>
    <div style="margin-top: 36px; display: flex; justify-content: center; gap: 16px; flex-wrap: wrap;">
      <a href="#programs" style="background: #ffffff; color: #000000; padding: 14px 32px; border-radius: 12px; font-size: 14px; font-weight: 900; text-decoration: none; display: inline-block;">Explore Programs</a>
      <a href="/contact" style="background: transparent; border: 1px solid rgba(255,255,255,0.25); color: #ffffff; padding: 14px 32px; border-radius: 12px; font-size: 14px; font-weight: 900; text-decoration: none; display: inline-block;">Contact Us</a>
    </div>
  </div>
</section>`,
        },
        {
          id: "def-home-stats",
          title: "Key Statistics",
          sectionType: "stats",
          sortOrder: 1,
          code: `<section style="background: #09090b; border-top: 1px solid #27272a; border-bottom: 1px solid #27272a; padding: 50px 24px; color: #ffffff; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
  <div style="max-width: 1100px; margin: 0 auto; display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; text-align: center;">
    <div>
      <div style="font-size: 38px; font-weight: 900; color: #38bdf8;">15,000+</div>
      <div style="font-size: 13px; color: #a1a1aa; font-weight: 700; margin-top: 4px; text-transform: uppercase;">Enrolled Students</div>
    </div>
    <div>
      <div style="font-size: 38px; font-weight: 900; color: #38bdf8;">120+</div>
      <div style="font-size: 13px; color: #a1a1aa; font-weight: 700; margin-top: 4px; text-transform: uppercase;">Degree Programs</div>
    </div>
    <div>
      <div style="font-size: 38px; font-weight: 900; color: #38bdf8;">96%</div>
      <div style="font-size: 13px; color: #a1a1aa; font-weight: 700; margin-top: 4px; text-transform: uppercase;">Placement Rate</div>
    </div>
    <div>
      <div style="font-size: 38px; font-weight: 900; color: #38bdf8;">50+</div>
      <div style="font-size: 13px; color: #a1a1aa; font-weight: 700; margin-top: 4px; text-transform: uppercase;">Research Labs</div>
    </div>
  </div>
</section>`,
        },
        {
          id: "def-home-features",
          title: "Campus Highlights",
          sectionType: "features",
          sortOrder: 2,
          code: `<section style="background: #000000; color: #ffffff; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
  <div style="max-width: 1100px; margin: 0 auto;">
    <div style="text-align: center; margin-bottom: 50px;">
      <h2 style="font-size: 36px; font-weight: 900; margin: 0;">Why Choose Our Campus</h2>
      <p style="color: #a1a1aa; margin-top: 10px; font-size: 16px;">World-class infrastructure designed for hands-on learning and research.</p>
    </div>
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;">
      <div style="background: #18181b; border: 1px solid #27272a; padding: 32px; border-radius: 16px;">
        <div style="font-size: 28px; margin-bottom: 16px;">🔬</div>
        <h3 style="font-size: 20px; font-weight: 800; margin: 0 0 10px 0;">Advanced Research Labs</h3>
        <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6; margin: 0;">Equipped with modern AI computing clusters, robotics equipment, and biotech facilities.</p>
      </div>
      <div style="background: #18181b; border: 1px solid #27272a; padding: 32px; border-radius: 16px;">
        <div style="font-size: 28px; margin-bottom: 16px;">👨‍🏫</div>
        <h3 style="font-size: 20px; font-weight: 800; margin: 0 0 10px 0;">Expert Industry Faculty</h3>
        <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6; margin: 0;">Learn directly from seasoned professors and visiting industry executives.</p>
      </div>
      <div style="background: #18181b; border: 1px solid #27272a; padding: 32px; border-radius: 16px;">
        <div style="font-size: 28px; margin-bottom: 16px;">🌐</div>
        <h3 style="font-size: 20px; font-weight: 800; margin: 0 0 10px 0;">Global Career Opportunities</h3>
        <p style="color: #a1a1aa; font-size: 14px; line-height: 1.6; margin: 0;">Direct campus placements with top global technology companies and research institutions.</p>
      </div>
    </div>
  </div>
</section>`,
        },
      ],
    },
    {
      slug: "/about",
      title: "About Us",
      sections: [
        {
          id: "def-about-hero",
          title: "About Header",
          sectionType: "about",
          sortOrder: 0,
          code: `<section style="background: #0f172a; color: #ffffff; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box; text-align: center;">
  <div style="max-width: 900px; margin: 0 auto;">
    <span style="color: #38bdf8; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em;">OUR HERITAGE & VISION</span>
    <h1 style="font-size: 44px; font-weight: 900; margin-top: 16px; color: #ffffff;">About Our Institution</h1>
    <p style="font-size: 16px; color: #94a3b8; margin-top: 16px; line-height: 1.7; max-width: 700px; margin-left: auto; margin-right: auto;">
      Founded with a commitment to academic rigor and societal advancement, our institution nurtures critical thinkers, groundbreaking researchers, and compassionate leaders.
    </p>
  </div>
</section>`,
        },
        {
          id: "def-about-mission",
          title: "Mission & Vision",
          sectionType: "about",
          sortOrder: 1,
          code: `<section style="background: #020617; color: #ffffff; padding: 70px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
  <div style="max-width: 1000px; margin: 0 auto; display: grid; grid-template-columns: 1fr 1fr; gap: 32px;">
    <div style="background: #0f172a; border: 1px solid #1e293b; padding: 36px; border-radius: 16px;">
      <h3 style="font-size: 24px; font-weight: 800; color: #38bdf8; margin: 0 0 12px 0;">Our Mission</h3>
      <p style="color: #94a3b8; font-size: 15px; line-height: 1.7; margin: 0;">To provide transformative education combining technical excellence, ethical leadership, and creative problem solving across all academic disciplines.</p>
    </div>
    <div style="background: #0f172a; border: 1px solid #1e293b; padding: 36px; border-radius: 16px;">
      <h3 style="font-size: 24px; font-weight: 800; color: #38bdf8; margin: 0 0 12px 0;">Our Vision</h3>
      <p style="color: #94a3b8; font-size: 15px; line-height: 1.7; margin: 0;">To be recognized globally as a center of educational innovation, fostering impactful research that addresses regional and global societal needs.</p>
    </div>
  </div>
</section>`,
        },
      ],
    },
    {
      slug: "/academics",
      title: "Academics",
      sections: [
        {
          id: "def-academics-hero",
          title: "Academics Header",
          sectionType: "courses",
          sortOrder: 0,
          code: `<section style="background: #000000; color: #ffffff; padding: 80px 24px; text-align: center; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
  <div style="max-width: 900px; margin: 0 auto;">
    <span style="color: #a855f7; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em;">ACADEMIC PROGRAMS</span>
    <h1 style="font-size: 44px; font-weight: 900; margin-top: 16px;">Degrees & Departments</h1>
    <p style="font-size: 16px; color: #a1a1aa; margin-top: 16px; line-height: 1.6;">Comprehensive undergraduate, postgraduate, and doctoral degree paths.</p>
  </div>
</section>`,
        },
        {
          id: "def-academics-grid",
          title: "Programs Grid",
          sectionType: "courses",
          sortOrder: 1,
          code: `<section style="background: #09090b; color: #ffffff; padding: 70px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
  <div style="max-width: 1100px; margin: 0 auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;">
    <div style="background: #18181b; border: 1px solid #27272a; padding: 28px; border-radius: 14px;">
      <span style="font-size: 11px; font-weight: 800; color: #a855f7; text-transform: uppercase;">School of Engineering</span>
      <h3 style="font-size: 20px; font-weight: 800; margin: 10px 0 8px 0;">B.Tech Computer Science</h3>
      <p style="color: #a1a1aa; font-size: 13px; margin: 0 0 16px 0;">4 Years • Full-Time Degree</p>
      <p style="color: #71717a; font-size: 14px; line-height: 1.5; margin: 0;">Specializations in Artificial Intelligence, Cloud Computing, and Cybersecurity.</p>
    </div>
    <div style="background: #18181b; border: 1px solid #27272a; padding: 28px; border-radius: 14px;">
      <span style="font-size: 11px; font-weight: 800; color: #a855f7; text-transform: uppercase;">School of Business</span>
      <h3 style="font-size: 20px; font-weight: 800; margin: 10px 0 8px 0;">MBA Business Analytics</h3>
      <p style="color: #a1a1aa; font-size: 13px; margin: 0 0 16px 0;">2 Years • Postgraduate</p>
      <p style="color: #71717a; font-size: 14px; line-height: 1.5; margin: 0;">Focusing on financial modeling, data analytics, and strategic leadership.</p>
    </div>
    <div style="background: #18181b; border: 1px solid #27272a; padding: 28px; border-radius: 14px;">
      <span style="font-size: 11px; font-weight: 800; color: #a855f7; text-transform: uppercase;">School of Sciences</span>
      <h3 style="font-size: 20px; font-weight: 800; margin: 10px 0 8px 0;">B.Sc Biotechnology</h3>
      <p style="color: #a1a1aa; font-size: 13px; margin: 0 0 16px 0;">3 Years • Undergraduate</p>
      <p style="color: #71717a; font-size: 14px; line-height: 1.5; margin: 0;">Hands-on lab research in genetic engineering, bioinformatics, and pharmacology.</p>
    </div>
  </div>
</section>`,
        },
      ],
    },
    {
      slug: "/placements",
      title: "Placements",
      sections: [
        {
          id: "def-placements-hero",
          title: "Placements Header",
          sectionType: "placements",
          sortOrder: 0,
          code: `<section style="background: #000000; color: #ffffff; padding: 80px 24px; text-align: center; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
  <div style="max-width: 900px; margin: 0 auto;">
    <span style="color: #22c55e; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em;">CAREERS & OUTCOMES</span>
    <h1 style="font-size: 44px; font-weight: 900; margin-top: 16px;">Campus Placement Cell</h1>
    <p style="font-size: 16px; color: #a1a1aa; margin-top: 16px; line-height: 1.6;">Connecting talented graduates with premier global organizations.</p>
  </div>
</section>`,
        },
        {
          id: "def-placements-stats",
          title: "Placement Highlights",
          sectionType: "placements",
          sortOrder: 1,
          code: `<section style="background: #052e16; border-top: 1px solid #14532d; padding: 60px 24px; color: #ffffff; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
  <div style="max-width: 1000px; margin: 0 auto; display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; text-align: center;">
    <div style="background: #022c22; padding: 30px; border-radius: 16px; border: 1px solid #065f46;">
      <div style="font-size: 42px; font-weight: 900; color: #4ade80;">₹45 LPA</div>
      <div style="font-size: 13px; color: #a7f3d0; margin-top: 6px; font-weight: 800; uppercase;">Highest Package</div>
    </div>
    <div style="background: #022c22; padding: 30px; border-radius: 16px; border: 1px solid #065f46;">
      <div style="font-size: 42px; font-weight: 900; color: #4ade80;">₹9.5 LPA</div>
      <div style="font-size: 13px; color: #a7f3d0; margin-top: 6px; font-weight: 800; uppercase;">Average Package</div>
    </div>
    <div style="background: #022c22; padding: 30px; border-radius: 16px; border: 1px solid #065f46;">
      <div style="font-size: 42px; font-weight: 900; color: #4ade80;">250+</div>
      <div style="font-size: 13px; color: #a7f3d0; margin-top: 6px; font-weight: 800; uppercase;">Recruiting Partners</div>
    </div>
  </div>
</section>`,
        },
      ],
    },
    {
      slug: "/contact",
      title: "Contact Us",
      sections: [
        {
          id: "def-contact-hero",
          title: "Contact Header & Cards",
          sectionType: "contact",
          sortOrder: 0,
          code: `<section style="background: #000000; color: #ffffff; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
  <div style="max-width: 1000px; margin: 0 auto;">
    <div style="text-align: center; margin-bottom: 50px;">
      <span style="color: #38bdf8; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em;">GET IN TOUCH</span>
      <h1 style="font-size: 44px; font-weight: 900; margin-top: 12px;">Contact & Campus Address</h1>
      <p style="font-size: 16px; color: #a1a1aa; margin-top: 10px;">We are here to assist with admissions, inquiries, and campus visits.</p>
    </div>
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;">
      <div style="background: #18181b; border: 1px solid #27272a; padding: 28px; border-radius: 14px; text-align: center;">
        <div style="font-size: 24px; margin-bottom: 12px;">📍</div>
        <h3 style="font-size: 18px; font-weight: 800; margin: 0 0 6px 0;">Campus Location</h3>
        <p style="color: #a1a1aa; font-size: 13px; margin: 0; line-height: 1.5;">University Road, Tech City, Campus District</p>
      </div>
      <div style="background: #18181b; border: 1px solid #27272a; padding: 28px; border-radius: 14px; text-align: center;">
        <div style="font-size: 24px; margin-bottom: 12px;">📞</div>
        <h3 style="font-size: 18px; font-weight: 800; margin: 0 0 6px 0;">Admission Helpline</h3>
        <p style="color: #a1a1aa; font-size: 13px; margin: 0; line-height: 1.5;">+91 (044) 2800-9000<br/>Mon - Sat (9am - 5pm)</p>
      </div>
      <div style="background: #18181b; border: 1px solid #27272a; padding: 28px; border-radius: 14px; text-align: center;">
        <div style="font-size: 24px; margin-bottom: 12px;">✉️</div>
        <h3 style="font-size: 18px; font-weight: 800; margin: 0 0 6px 0;">Email Support</h3>
        <p style="color: #a1a1aa; font-size: 13px; margin: 0; line-height: 1.5;">admissions@campus.ac.in<br/>info@campus.ac.in</p>
      </div>
    </div>
  </div>
</section>`,
        },
      ],
    },
  ],
};

/** Ensure service_secrets or system table holds default website config */
export async function getDefaultWebsiteConfig(): Promise<DefaultWebsiteConfig> {
  try {
    const { rows } = await pool.query(
      "SELECT secret_value FROM service_secrets WHERE secret_name = $1",
      ["DEFAULT_WEBSITE_CONFIG"]
    );
    if (rows.length > 0 && rows[0].secret_value) {
      const parsed = JSON.parse(rows[0].secret_value);
      if (parsed && Array.isArray(parsed.pages)) {
        return parsed as DefaultWebsiteConfig;
      }
    }
  } catch (err) {
    console.error("Error reading default website config from DB:", err);
  }
  return INITIAL_DEFAULT_WEBSITE;
}

export async function updateDefaultWebsiteConfig(
  config: DefaultWebsiteConfig
): Promise<DefaultWebsiteConfig> {
  const jsonStr = JSON.stringify(config);
  await pool.query(
    `INSERT INTO service_secrets (id, secret_name, secret_value, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, NOW(), NOW())
     ON CONFLICT (secret_name) DO UPDATE SET secret_value = $2, updated_at = NOW()`,
    ["DEFAULT_WEBSITE_CONFIG", jsonStr]
  );
  return config;
}
