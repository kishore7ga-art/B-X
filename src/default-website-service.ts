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

// Rich initial default website structure with ALL 19 SECTIONS for Home Page
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
          code: `<header style="background: #0d1527; color: #ffffff; padding: 18px 40px; display: flex; align-items: center; justify-content: space-between; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box; border-bottom: 1px solid rgba(255,255,255,0.1);">
    <div style="display: flex; align-items: center; gap: 12px;">
      <div style="width: 40px; height: 40px; border-radius: 10px; background: #2563eb; color: #ffffff; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 18px;">🎓</div>
      <span style="font-size: 20px; font-weight: 900; color: #ffffff;">GREENFIELD UNIVERSITY</span>
    </div>
    <nav style="display: flex; gap: 24px; font-size: 14px; font-weight: 700;">
      <a href="#about" style="color: #cbd5e1; text-decoration: none;">About</a>
      <a href="#courses" style="color: #cbd5e1; text-decoration: none;">Academics</a>
      <a href="#admissions" style="color: #cbd5e1; text-decoration: none;">Admissions</a>
      <a href="#placements" style="color: #cbd5e1; text-decoration: none;">Placements</a>
      <a href="#contact" style="color: #cbd5e1; text-decoration: none;">Contact</a>
    </nav>
    <a href="#apply" style="background: #2563eb; color: #ffffff; padding: 10px 24px; border-radius: 10px; font-size: 13px; font-weight: 800; text-decoration: none;">Apply Now</a>
  </header>`,
        },
        {
          id: "def-home-hero",
          title: "Hero Banner",
          sectionType: "hero",
          sortOrder: 1,
          code: `<section style="background: #090d16; color: #ffffff; padding: 90px 24px; text-align: center; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 900px; margin: 0 auto;">
      <span style="background: rgba(37,99,235,0.2); border: 1px solid #2563eb; color: #60a5fa; padding: 6px 20px; border-radius: 9999px; font-size: 12px; font-weight: 800; text-transform: uppercase;">A++ Accredited University</span>
      <h1 style="font-size: 52px; font-weight: 900; margin-top: 24px; line-height: 1.1; color: #ffffff;">Excellence in Higher Education & Innovation</h1>
      <p style="font-size: 18px; color: #94a3b8; margin-top: 18px; line-height: 1.6; max-width: 720px; margin-left: auto; margin-right: auto;">Empowering future leaders with world-class faculty, modern research laboratories, and vibrant campus life.</p>
      <div style="margin-top: 36px; display: flex; justify-content: center; gap: 16px;">
        <a href="#courses" style="background: #2563eb; color: #ffffff; padding: 14px 32px; border-radius: 12px; font-size: 14px; font-weight: 900; text-decoration: none;">Explore Programs</a>
        <a href="#contact" style="background: transparent; border: 1px solid #334155; color: #ffffff; padding: 14px 32px; border-radius: 12px; font-size: 14px; font-weight: 900; text-decoration: none;">Contact Us</a>
      </div>
    </div>
  </section>`,
        },
        {
          id: "def-home-highlights",
          title: "College Highlights",
          sectionType: "highlights",
          sortOrder: 2,
          code: `<section style="background: #0f172a; color: #ffffff; padding: 60px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1100px; margin: 0 auto; display: grid; grid-template-columns: repeat(4, 1fr); gap: 24px; text-align: center;">
      <div style="padding: 24px; background: #1e293b; border-radius: 16px; border: 1px solid #334155;"><h3 style="font-size: 36px; font-weight: 900; color: #38bdf8; margin: 0;">#15</h3><p style="font-size: 13px; color: #94a3b8; font-weight: 700; margin-top: 6px;">NIRF National Rank</p></div>
      <div style="padding: 24px; background: #1e293b; border-radius: 16px; border: 1px solid #334155;"><h3 style="font-size: 36px; font-weight: 900; color: #38bdf8; margin: 0;">98.4%</h3><p style="font-size: 13px; color: #94a3b8; font-weight: 700; margin-top: 6px;">Placement Record</p></div>
      <div style="padding: 24px; background: #1e293b; border-radius: 16px; border: 1px solid #334155;"><h3 style="font-size: 36px; font-weight: 900; color: #38bdf8; margin: 0;">500+</h3><p style="font-size: 13px; color: #94a3b8; font-weight: 700; margin-top: 6px;">Top Recruiters</p></div>
      <div style="padding: 24px; background: #1e293b; border-radius: 16px; border: 1px solid #334155;"><h3 style="font-size: 36px; font-weight: 900; color: #38bdf8; margin: 0;">15,000+</h3><p style="font-size: 13px; color: #94a3b8; font-weight: 700; margin-top: 6px;">Active Students</p></div>
    </div>
  </section>`,
        },
        {
          id: "def-home-about",
          title: "About College",
          sectionType: "about",
          sortOrder: 3,
          code: `<section style="background: #ffffff; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1000px; margin: 0 auto; display: grid; grid-template-columns: 1fr 1fr; gap: 48px; align-items: center;">
      <div>
        <span style="color: #2563eb; font-size: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.1em;">OUR HERITAGE</span>
        <h2 style="font-size: 36px; font-weight: 900; margin-top: 12px; color: #0f172a;">Building Tomorrow's Global Tech Leaders</h2>
        <p style="font-size: 15px; color: #475569; margin-top: 16px; line-height: 1.7;">Established in 1985, Greenfield University has been at the forefront of academic excellence, technological innovation, and societal advancement for over four decades.</p>
      </div>
      <div style="background: #f1f5f9; padding: 32px; border-radius: 24px; border: 1px solid #e2e8f0;">
        <h4 style="font-size: 18px; font-weight: 900; color: #0f172a; margin: 0;">Key Accreditations</h4>
        <ul style="margin-top: 16px; padding-left: 20px; color: #334155; font-size: 14px; font-weight: 600; line-height: 1.8;">
          <li>NAAC A++ Grade Accreditation</li>
          <li>AICTE & UGC Approved University</li>
          <li>NIRF Top 20 Engineering Institutions</li>
        </ul>
      </div>
    </div>
  </section>`,
        },
        {
          id: "def-home-vision",
          title: "Vision & Mission",
          sectionType: "vision",
          sortOrder: 4,
          code: `<section style="background: #f8fafc; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1000px; margin: 0 auto; text-align: center;">
      <h2 style="font-size: 36px; font-weight: 900; color: #0f172a;">Vision & Mission Statement</h2>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 32px; margin-top: 40px;">
        <div style="background: #ffffff; padding: 36px; border-radius: 20px; border: 1px solid #e2e8f0; text-align: left; box-shadow: 0 4px 6px rgba(0,0,0,0.03);">
          <div style="font-size: 28px; margin-bottom: 12px;">🎯</div>
          <h3 style="font-size: 20px; font-weight: 900; color: #0f172a;">Institutional Vision</h3>
          <p style="font-size: 14px; color: #475569; margin-top: 10px; line-height: 1.7;">To be a globally recognized center of academic excellence and research that produces visionary leaders and ethical global citizens.</p>
        </div>
        <div style="background: #ffffff; padding: 36px; border-radius: 20px; border: 1px solid #e2e8f0; text-align: left; box-shadow: 0 4px 6px rgba(0,0,0,0.03);">
          <div style="font-size: 28px; margin-bottom: 12px;">🚀</div>
          <h3 style="font-size: 20px; font-weight: 900; color: #0f172a;">Core Mission</h3>
          <p style="font-size: 14px; color: #475569; margin-top: 10px; line-height: 1.7;">To impart high-quality education, foster innovative research, and nurture industry-ready talent through holistic experiential learning.</p>
        </div>
      </div>
    </div>
  </section>`,
        },
        {
          id: "def-home-courses",
          title: "Courses / Programs Offered",
          sectionType: "courses",
          sortOrder: 5,
          code: `<section style="background: #ffffff; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1100px; margin: 0 auto;">
      <div style="text-align: center; max-width: 700px; margin: 0 auto;">
        <span style="color: #2563eb; font-size: 12px; font-weight: 900; text-transform: uppercase;">ACADEMIC DEGREES</span>
        <h2 style="font-size: 36px; font-weight: 900; margin-top: 8px;">Explore Our Degree Programs</h2>
      </div>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 48px;">
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 28px; border-radius: 20px;"><h3 style="font-size: 18px; font-weight: 900; color: #0f172a;">B.Tech Computer Science</h3><p style="font-size: 13px; color: #64748b; margin-top: 8px;">4 Years Undergraduate Degree in AI, ML & Software Systems.</p><a href="#apply" style="color: #2563eb; font-size: 13px; font-weight: 800; text-decoration: none; display: inline-block; margin-top: 16px;">View Curriculum →</a></div>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 28px; border-radius: 20px;"><h3 style="font-size: 18px; font-weight: 900; color: #0f172a;">M.Tech Data Science</h3><p style="font-size: 13px; color: #64748b; margin-top: 8px;">2 Years Postgraduate Specialization in Big Data Analytics.</p><a href="#apply" style="color: #2563eb; font-size: 13px; font-weight: 800; text-decoration: none; display: inline-block; margin-top: 16px;">View Curriculum →</a></div>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 28px; border-radius: 20px;"><h3 style="font-size: 18px; font-weight: 900; color: #0f172a;">MBA Business Analytics</h3><p style="font-size: 13px; color: #64748b; margin-top: 8px;">2 Years Management Program in Finance, Marketing & Operations.</p><a href="#apply" style="color: #2563eb; font-size: 13px; font-weight: 800; text-decoration: none; display: inline-block; margin-top: 16px;">View Curriculum →</a></div>
      </div>
    </div>
  </section>`,
        },
        {
          id: "def-home-departments",
          title: "Departments",
          sectionType: "departments",
          sortOrder: 6,
          code: `<section style="background: #f1f5f9; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1100px; margin: 0 auto;">
      <h2 style="font-size: 32px; font-weight: 900; text-align: center;">Academic Departments</h2>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 40px;">
        <div style="background: #ffffff; padding: 24px; border-radius: 16px; border: 1px solid #e2e8f0;"><h4 style="font-size: 16px; font-weight: 900;">School of Engineering</h4><p style="font-size: 13px; color: #64748b; margin-top: 6px;">CSE, ECE, Mechanical, Civil & AI Labs</p></div>
        <div style="background: #ffffff; padding: 24px; border-radius: 16px; border: 1px solid #e2e8f0;"><h4 style="font-size: 16px; font-weight: 900;">School of Management</h4><p style="font-size: 13px; color: #64748b; margin-top: 6px;">MBA, BBA, Finance & HR Specializations</p></div>
        <div style="background: #ffffff; padding: 24px; border-radius: 16px; border: 1px solid #e2e8f0;"><h4 style="font-size: 16px; font-weight: 900;">School of Basic Sciences</h4><p style="font-size: 13px; color: #64748b; margin-top: 6px;">Physics, Chemistry & Applied Mathematics</p></div>
      </div>
    </div>
  </section>`,
        },
        {
          id: "def-home-admissions",
          title: "Admission Section",
          sectionType: "admissions",
          sortOrder: 7,
          code: `<section style="background: #0f172a; color: #ffffff; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 900px; margin: 0 auto; text-align: center;">
      <span style="background: #2563eb; color: #ffffff; padding: 4px 16px; border-radius: 9999px; font-size: 11px; font-weight: 900;">ADMISSIONS 2026-27 OPEN</span>
      <h2 style="font-size: 38px; font-weight: 900; margin-top: 16px;">Begin Your Journey With Us</h2>
      <p style="font-size: 15px; color: #94a3b8; margin-top: 12px;">Applications are open for UG & PG academic sessions. Merit scholarship applications closing soon.</p>
      <div style="margin-top: 32px; display: flex; justify-content: center; gap: 16px;">
        <a href="#apply" style="background: #2563eb; color: #ffffff; padding: 14px 32px; border-radius: 12px; font-size: 14px; font-weight: 900; text-decoration: none;">Apply Online Now</a>
        <a href="#prospectus" style="background: #1e293b; color: #ffffff; border: 1px solid #334155; padding: 14px 32px; border-radius: 12px; font-size: 14px; font-weight: 900; text-decoration: none;">Download Prospectus PDF</a>
      </div>
    </div>
  </section>`,
        },
        {
          id: "def-home-placements",
          title: "Placement & Recruiters",
          sectionType: "placements",
          sortOrder: 8,
          code: `<section style="background: #ffffff; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1100px; margin: 0 auto; text-align: center;">
      <h2 style="font-size: 36px; font-weight: 900;">Placement & Top Recruiters</h2>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; margin-top: 36px;">
        <div style="background: #f8fafc; padding: 24px; border-radius: 16px; border: 1px solid #e2e8f0;"><h3 style="font-size: 32px; font-weight: 900; color: #2563eb; margin: 0;">₹52 LPA</h3><p style="font-size: 13px; color: #64748b; font-weight: 700;">Highest National Package</p></div>
        <div style="background: #f8fafc; padding: 24px; border-radius: 16px; border: 1px solid #e2e8f0;"><h3 style="font-size: 32px; font-weight: 900; color: #2563eb; margin: 0;">₹12.4 LPA</h3><p style="font-size: 13px; color: #64748b; font-weight: 700;">Average Campus Salary</p></div>
        <div style="background: #f8fafc; padding: 24px; border-radius: 16px; border: 1px solid #e2e8f0;"><h3 style="font-size: 32px; font-weight: 900; color: #2563eb; margin: 0;">450+</h3><p style="font-size: 13px; color: #64748b; font-weight: 700;">Recruiting Partners</p></div>
      </div>
    </div>
  </section>`,
        },
        {
          id: "def-home-facilities",
          title: "Campus Facilities",
          sectionType: "facilities",
          sortOrder: 9,
          code: `<section style="background: #f8fafc; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1100px; margin: 0 auto; text-align: center;">
      <h2 style="font-size: 32px; font-weight: 900;">World-Class Campus Infrastructure</h2>
      <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-top: 36px;">
        <div style="background: #ffffff; padding: 20px; border-radius: 16px; border: 1px solid #e2e8f0;"><div style="font-size: 24px;">📚</div><h4 style="font-size: 15px; font-weight: 900; margin-top: 8px;">Digital Library</h4></div>
        <div style="background: #ffffff; padding: 20px; border-radius: 16px; border: 1px solid #e2e8f0;"><div style="font-size: 24px;">🏢</div><h4 style="font-size: 15px; font-weight: 900; margin-top: 8px;">Modern Hostels</h4></div>
        <div style="background: #ffffff; padding: 20px; border-radius: 16px; border: 1px solid #e2e8f0;"><div style="font-size: 24px;">⚽</div><h4 style="font-size: 15px; font-weight: 900; margin-top: 8px;">Sports Complex</h4></div>
        <div style="background: #ffffff; padding: 20px; border-radius: 16px; border: 1px solid #e2e8f0;"><div style="font-size: 24px;">🔬</div><h4 style="font-size: 15px; font-weight: 900; margin-top: 8px;">Advanced Research Labs</h4></div>
      </div>
    </div>
  </section>`,
        },
        {
          id: "def-home-research",
          title: "Research & Innovation",
          sectionType: "research",
          sortOrder: 10,
          code: `<section style="background: #0d1527; color: #ffffff; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1000px; margin: 0 auto; text-align: center;">
      <span style="color: #38bdf8; font-size: 12px; font-weight: 900; text-transform: uppercase;">PATENTS & R&D</span>
      <h2 style="font-size: 36px; font-weight: 900; margin-top: 10px;">Pioneering Research & Innovation Labs</h2>
      <p style="font-size: 15px; color: #94a3b8; margin-top: 14px; max-width: 700px; margin-left: auto; margin-right: auto;">Over 120+ published research papers and 35 national patents filed in AI, Robotics, Renewable Energy & Semiconductor Design.</p>
    </div>
  </section>`,
        },
        {
          id: "def-home-news",
          title: "News & Announcements",
          sectionType: "news",
          sortOrder: 11,
          code: `<section style="background: #ffffff; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1100px; margin: 0 auto;">
      <h2 style="font-size: 32px; font-weight: 900; text-align: center;">News & Official Circulars</h2>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 36px;">
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 20px; border-radius: 16px;"><span style="font-size: 11px; font-weight: 800; color: #2563eb;">AUG 10, 2026</span><h4 style="font-size: 15px; font-weight: 900; margin-top: 6px;">End-Semester Examination Schedule Released</h4></div>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 20px; border-radius: 16px;"><span style="font-size: 11px; font-weight: 800; color: #2563eb;">AUG 15, 2026</span><h4 style="font-size: 15px; font-weight: 900; margin-top: 6px;">79th Independence Day Celebration Convocation</h4></div>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 20px; border-radius: 16px;"><span style="font-size: 11px; font-weight: 800; color: #2563eb;">SEP 01, 2026</span><h4 style="font-size: 15px; font-weight: 900; margin-top: 6px;">International Student Exchange Orientation</h4></div>
      </div>
    </div>
  </section>`,
        },
        {
          id: "def-home-events",
          title: "Upcoming Events",
          sectionType: "events",
          sortOrder: 12,
          code: `<section style="background: #f1f5f9; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1000px; margin: 0 auto;">
      <h2 style="font-size: 32px; font-weight: 900; text-align: center;">Upcoming Campus Events</h2>
      <div style="display: flex; flex-direction: column; gap: 16px; margin-top: 36px;">
        <div style="background: #ffffff; padding: 20px 28px; border-radius: 16px; border: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between;"><div style="display: flex; align-items: center; gap: 20px;"><div style="background: #0f172a; color: #ffffff; padding: 10px 16px; border-radius: 12px; font-weight: 900; text-align: center;"><span style="font-size: 18px; display: block;">24</span><span style="font-size: 11px;">AUG</span></div><div><h4 style="font-size: 16px; font-weight: 900; margin: 0;">Global Tech Hackathon 2026</h4><p style="font-size: 13px; color: #64748b; margin-top: 4px;">48-Hour Inter-College Coding Competition</p></div></div><a href="#register" style="background: #2563eb; color: #ffffff; padding: 8px 20px; border-radius: 10px; font-size: 12px; font-weight: 800; text-decoration: none;">Register Now</a></div>
      </div>
    </div>
  </section>`,
        },
        {
          id: "def-home-gallery",
          title: "Gallery / Campus Life",
          sectionType: "gallery",
          sortOrder: 13,
          code: `<section style="background: #ffffff; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1100px; margin: 0 auto; text-align: center;">
      <h2 style="font-size: 32px; font-weight: 900;">Vibrant Campus Life & Infrastructure</h2>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-top: 36px;">
        <div style="height: 200px; background: #e2e8f0; border-radius: 16px; display: flex; align-items: center; justify-content: center; font-weight: 800; color: #64748b;">Central Auditorium</div>
        <div style="height: 200px; background: #cbd5e1; border-radius: 16px; display: flex; align-items: center; justify-content: center; font-weight: 800; color: #334155;">Sports Arena</div>
        <div style="height: 200px; background: #94a3b8; border-radius: 16px; display: flex; align-items: center; justify-content: center; font-weight: 800; color: #ffffff;">Robotics Research Lab</div>
      </div>
    </div>
  </section>`,
        },
        {
          id: "def-home-testimonials",
          title: "Student Testimonials",
          sectionType: "testimonials",
          sortOrder: 14,
          code: `<section style="background: #0f172a; color: #ffffff; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1000px; margin: 0 auto; text-align: center;">
      <h2 style="font-size: 32px; font-weight: 900;">What Our Students & Alumni Say</h2>
      <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; margin-top: 36px; text-align: left;">
        <div style="background: #1e293b; padding: 28px; border-radius: 20px; border: 1px solid #334155;"><p style="font-size: 14px; color: #cbd5e1; line-height: 1.6;">"The hands-on coding labs and mentor support at Greenfield helped me secure a Software Engineer role at Google."</p><span style="font-size: 13px; font-weight: 900; color: #38bdf8; display: block; margin-top: 16px;">— Rahul Sharma (B.Tech CSE '25)</span></div>
        <div style="background: #1e293b; padding: 28px; border-radius: 20px; border: 1px solid #334155;"><p style="font-size: 14px; color: #cbd5e1; line-height: 1.6;">"World-class faculty, vibrant campus events, and incredible placement opportunities made my university years unforgettable."</p><span style="font-size: 13px; font-weight: 900; color: #38bdf8; display: block; margin-top: 16px;">— Priya Sundaram (MBA '24)</span></div>
      </div>
    </div>
  </section>`,
        },
        {
          id: "def-home-achievements",
          title: "Achievements & Awards",
          sectionType: "achievements",
          sortOrder: 15,
          code: `<section style="background: #ffffff; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1100px; margin: 0 auto; text-align: center;">
      <h2 style="font-size: 32px; font-weight: 900;">Awards & Recognitions</h2>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 36px;">
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 24px; border-radius: 16px;"><div style="font-size: 28px;">🏆</div><h4 style="font-size: 16px; font-weight: 900; margin-top: 8px;">Best Green Campus Award 2025</h4></div>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 24px; border-radius: 16px;"><div style="font-size: 28px;">🎖️</div><h4 style="font-size: 16px; font-weight: 900; margin-top: 8px;">Top 10 Private Engineering University</h4></div>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; padding: 24px; border-radius: 16px;"><div style="font-size: 28px;">🌟</div><h4 style="font-size: 16px; font-weight: 900; margin-top: 8px;">National Patent Excellence Citation</h4></div>
      </div>
    </div>
  </section>`,
        },
        {
          id: "def-home-contact",
          title: "Contact / Enquiry Form",
          sectionType: "contact",
          sortOrder: 16,
          code: `<section style="background: #f8fafc; color: #0f172a; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 800px; margin: 0 auto; background: #ffffff; padding: 40px; border-radius: 24px; border: 1px solid #e2e8f0; box-shadow: 0 10px 30px rgba(0,0,0,0.05);">
      <h2 style="font-size: 28px; font-weight: 900; text-align: center;">Admissions & Enquiry Form</h2>
      <form style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 28px;">
        <input type="text" placeholder="Full Name *" style="height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid #cbd5e1; font-size: 13px;" />
        <input type="email" placeholder="Email Address *" style="height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid #cbd5e1; font-size: 13px;" />
        <input type="tel" placeholder="Mobile Number *" style="height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid #cbd5e1; font-size: 13px;" />
        <select style="height: 44px; padding: 0 16px; border-radius: 10px; border: 1px solid #cbd5e1; font-size: 13px; color: #475569;"><option>Select Preferred Course</option><option>B.Tech CSE</option><option>M.Tech AI</option><option>MBA</option></select>
        <button type="submit" style="grid-column: span 2; height: 48px; background: #2563eb; color: #ffffff; border-radius: 12px; border: none; font-size: 14px; font-weight: 900; cursor: pointer; margin-top: 8px;">Submit Enquiry</button>
      </form>
    </div>
  </section>`,
        },
        {
          id: "def-home-map",
          title: "Map & Location",
          sectionType: "map",
          sortOrder: 17,
          code: `<section style="background: #0f172a; color: #ffffff; padding: 80px 24px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box;">
    <div style="max-width: 1000px; margin: 0 auto; text-align: center;">
      <h2 style="font-size: 32px; font-weight: 900;">Campus Location & Directions</h2>
      <p style="font-size: 14px; color: #94a3b8; margin-top: 8px;">Greenfield Campus, Knowledge Park III, Tech City - 600001</p>
      <div style="width: 100%; height: 260px; background: #1e293b; border-radius: 20px; border: 1px solid #334155; margin-top: 28px; display: flex; align-items: center; justify-content: center; font-weight: 800; color: #38bdf8;">📍 Interactive Google Map View</div>
    </div>
  </section>`,
        },
        {
          id: "def-home-footer",
          title: "Footer",
          sectionType: "footer",
          sortOrder: 18,
          code: `<footer style="background: #090d16; color: #94a3b8; padding: 40px 40px; font-family: system-ui, sans-serif; width: 100%; box-sizing: border-box; border-top: 1px solid #1e293b; text-align: center;">
    <p style="font-size: 13px; font-weight: 700; color: #cbd5e1; margin: 0;">© 2026 Greenfield University. All Rights Reserved.</p>
    <p style="font-size: 12px; color: #64748b; margin-top: 8px;">Approved by AICTE, UGC & Accredited by NAAC A++ Grade.</p>
  </footer>`,
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
          sectionType: "vision",
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

/** Ensure service_secrets table holds default website config with ALL 19 sections */
export async function getDefaultWebsiteConfig(): Promise<DefaultWebsiteConfig> {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM service_secrets WHERE name = $1",
      ["DEFAULT_WEBSITE_CONFIG"]
    );
    if (rows.length > 0 && rows[0].value) {
      const parsed = JSON.parse(rows[0].value);
      if (parsed && Array.isArray(parsed.pages)) {
        const homePage = parsed.pages.find((p: any) => p.slug === "/home");
        // Auto-upgrade DB record if home page has fewer than 19 default sections
        if (!homePage || !homePage.sections || homePage.sections.length < 19) {
          console.log("Auto-migrating DB default website config to 19 sections...");
          await updateDefaultWebsiteConfig(INITIAL_DEFAULT_WEBSITE);
          return INITIAL_DEFAULT_WEBSITE;
        }
        return parsed as DefaultWebsiteConfig;
      }
    }
  } catch (err) {
    console.error("Error reading default website config from DB:", err);
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
  const jsonStr = JSON.stringify(config);
  await pool.query(
    `INSERT INTO service_secrets (name, value, created_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (name) DO UPDATE SET value = $2`,
    ["DEFAULT_WEBSITE_CONFIG", jsonStr]
  );
  return config;
}
