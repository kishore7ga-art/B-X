import { z } from "zod";

/**
 * The kinds of institution onboarding asks about, and the template each one
 * opens with.
 *
 * One source of truth for three things that would otherwise drift apart: the
 * values stored in `College.collegeType`, the labels the onboarding form
 * renders, and the mapping "Build Site" uses to pick a template without asking.
 *
 * Templates are referenced by name rather than id because ids are cuids
 * generated at seed time and differ between databases — the name is the stable
 * key, and it is already `@unique`.
 */
export const COLLEGE_TYPES = [
  {
    value: "engineering",
    label: "Engineering",
    hint: "Technical institutes, polytechnics",
    templateName: "Radian",
  },
  {
    value: "arts_science",
    label: "Arts & Science",
    hint: "Degree colleges, liberal arts",
    templateName: "Meridian",
  },
  {
    value: "medical",
    label: "Medical",
    hint: "Medical, nursing, pharmacy",
    templateName: "Beacon",
  },
  {
    value: "management",
    label: "Management",
    hint: "Business schools, commerce",
    templateName: "Almanac",
  },
  {
    value: "law",
    label: "Law / Other",
    hint: "Law schools, and anything else",
    templateName: "Harbour",
  },
] as const;

export type CollegeTypeValue = (typeof COLLEGE_TYPES)[number]["value"];

/** For validating the onboarding form and anything that accepts a type. */
export const collegeTypeSchema = z.enum(
  COLLEGE_TYPES.map((type) => type.value) as [CollegeTypeValue, ...CollegeTypeValue[]],
);

const BY_VALUE = new Map(COLLEGE_TYPES.map((type) => [type.value, type]));

export function collegeType(value: string | null | undefined) {
  return value ? (BY_VALUE.get(value as CollegeTypeValue) ?? null) : null;
}

/**
 * The template a type opens with.
 *
 * Falls back to the last entry rather than throwing: a college carrying a type
 * this build no longer knows about should still get a site, and "Law / Other"
 * is the catch-all by design.
 */
export function templateNameFor(value: string | null | undefined): string {
  return (
    collegeType(value)?.templateName ??
    COLLEGE_TYPES[COLLEGE_TYPES.length - 1].templateName
  );
}

/**
 * A subdomain from a college's name, since onboarding asks for a name and the
 * URL has to come from somewhere.
 *
 * Uniqueness is not decided here — the caller checks the database and appends a
 * suffix, because only it knows what is already taken.
 */
export function subdomainFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    // Drop accents so "Ilhéus" does not become "ilhaus" or worse, empty.
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

  // A name of only punctuation would otherwise produce an empty subdomain,
  // which is a valid string and a broken URL.
  return slug || "college";
}
