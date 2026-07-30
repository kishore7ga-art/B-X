import { SectionType } from "@/generated/prisma/enums";
import {
  parseSectionContent,
  type SupportedSectionType,
} from "@/lib/sections/schemas";

/**
 * Starter content for a newly added section. Every field beyond the college
 * name has a default in its Zod schema, so parsing an (almost) empty object
 * gives us a valid, fully-populated content blob.
 */
export function defaultContentFor(
  sectionType: SupportedSectionType,
  collegeName: string,
) {
  if (sectionType === SectionType.HERO) {
    return parseSectionContent(SectionType.HERO, {
      collegeName,
      tagline: "Your college tagline",
      intro: "A short introduction to your institution.",
    });
  }

  return parseSectionContent(sectionType, {});
}
