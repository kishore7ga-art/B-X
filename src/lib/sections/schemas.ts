import { z } from "zod";

import { SectionType } from "@/generated/prisma/enums";

/**
 * Zod schema per section type for the `college_sections.content` JSONB column.
 * Fields follow the "Standard Sections" list in Section 3 of the spec.
 *
 * URLs are plain strings, not `z.url()` — uploaded images are stored as
 * site-relative paths like `/uploads/abc.jpg`.
 */

const url = z.string().trim();
const text = z.string().trim();

export const heroContentSchema = z.object({
  collegeName: text.min(1),
  tagline: text.default(""),
  intro: text.default(""),
  bannerImageUrl: url.default(""),
  ctaLabel: text.default(""),
  ctaHref: url.default(""),
});

export const aboutContentSchema = z.object({
  title: text.default("About Us"),
  history: text.default(""),
  mission: text.default(""),
  vision: text.default(""),
  principalName: text.default(""),
  principalDesignation: text.default(""),
  principalPhotoUrl: url.default(""),
  principalMessage: text.default(""),
});

export const courseItemSchema = z.object({
  name: text.min(1),
  duration: text.default(""),
  eligibility: text.default(""),
  description: text.default(""),
});

export const coursesContentSchema = z.object({
  title: text.default("Courses"),
  subtitle: text.default(""),
  courses: z.array(courseItemSchema).default([]),
});

export const facultyMemberSchema = z.object({
  name: text.min(1),
  designation: text.default(""),
  department: text.default(""),
  photoUrl: url.default(""),
});

export const facultyContentSchema = z.object({
  title: text.default("Faculty"),
  subtitle: text.default(""),
  members: z.array(facultyMemberSchema).default([]),
});

export const contactContentSchema = z.object({
  title: text.default("Contact Us"),
  address: text.default(""),
  phone: text.default(""),
  email: text.default(""),
  mapEmbedUrl: url.default(""),
  showContactForm: z.boolean().default(true),
});

/** Section types the MVP can render. */
export const SUPPORTED_SECTION_TYPES = [
  SectionType.HERO,
  SectionType.ABOUT,
  SectionType.COURSES,
  SectionType.FACULTY,
  SectionType.CONTACT,
] as const;

export type SupportedSectionType = (typeof SUPPORTED_SECTION_TYPES)[number];

export const sectionContentSchemas = {
  [SectionType.HERO]: heroContentSchema,
  [SectionType.ABOUT]: aboutContentSchema,
  [SectionType.COURSES]: coursesContentSchema,
  [SectionType.FACULTY]: facultyContentSchema,
  [SectionType.CONTACT]: contactContentSchema,
} satisfies Record<SupportedSectionType, z.ZodType>;

export type HeroContent = z.infer<typeof heroContentSchema>;
export type AboutContent = z.infer<typeof aboutContentSchema>;
export type CoursesContent = z.infer<typeof coursesContentSchema>;
export type FacultyContent = z.infer<typeof facultyContentSchema>;
export type ContactContent = z.infer<typeof contactContentSchema>;

/** Discriminated map from section type -> its parsed content type. */
export type SectionContentMap = {
  [SectionType.HERO]: HeroContent;
  [SectionType.ABOUT]: AboutContent;
  [SectionType.COURSES]: CoursesContent;
  [SectionType.FACULTY]: FacultyContent;
  [SectionType.CONTACT]: ContactContent;
};

/**
 * Takes a `string`, not a `SectionType`.
 *
 * Section types now arrive over HTTP as well as out of the database, and the
 * enum type is a promise the database keeps and a JSON body does not. Narrowing
 * from the wider type is the point of a guard; requiring the narrow one first
 * made it unusable exactly where the value is genuinely unverified.
 */
export function isSupportedSectionType(
  value: string,
): value is SupportedSectionType {
  return (SUPPORTED_SECTION_TYPES as readonly string[]).includes(value);
}

/** Throws on invalid content. Use when writing to the database. */
export function parseSectionContent<T extends SupportedSectionType>(
  sectionType: T,
  content: unknown,
): SectionContentMap[T] {
  return sectionContentSchemas[sectionType].parse(
    content,
  ) as SectionContentMap[T];
}

/** Never throws. Use when rendering, so one bad row can't break a whole site. */
export function safeParseSectionContent<T extends SupportedSectionType>(
  sectionType: T,
  content: unknown,
): SectionContentMap[T] | null {
  const result = sectionContentSchemas[sectionType].safeParse(content);
  return result.success ? (result.data as SectionContentMap[T]) : null;
}
