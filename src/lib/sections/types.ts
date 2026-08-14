export const SectionType = {
  NAVBAR: "navbar",
  HERO: "hero",
  HIGHLIGHTS: "highlights",
  ABOUT: "about",
  VISION: "vision",
  COURSES: "courses",
  FACULTY: "faculty",
  DEPARTMENTS: "departments",
  ADMISSIONS: "admissions",
  PLACEMENTS: "placements",
  FACILITIES: "facilities",
  RESEARCH: "research",
  NEWS: "news",
  EVENTS: "events",
  GALLERY: "gallery",
  TESTIMONIALS: "testimonials",
  ACHIEVEMENTS: "achievements",
  CONTACT: "contact",
  MAP: "map",
  FOOTER: "footer",
} as const;

export type SectionType = (typeof SectionType)[keyof typeof SectionType] | string;
