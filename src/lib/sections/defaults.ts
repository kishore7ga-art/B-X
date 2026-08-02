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
      tagline: "",
      intro: "",
    });
  }

  return parseSectionContent(sectionType, {});
}

export function sanitizeSectionContent(
  sectionType: string,
  content: unknown,
): unknown {
  if (
    sectionType === SectionType.HERO &&
    content &&
    typeof content === "object"
  ) {
    const h = { ...(content as Record<string, unknown>) };
    if (h.tagline === "Your college tagline") h.tagline = "";
    if (h.intro === "A short introduction to your institution.") h.intro = "";
    return h;
  }
  return content;
}
