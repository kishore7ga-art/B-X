/**
 * Ensures a section or template title/name is unique among existing names
 * by appending an incrementing or distinct number suffix (e.g. "Hero 2", "About Us 3",
 * "Hero Banner [hero] - Hero Banner Variant 2") so that no two sections share the exact same name.
 */
export function getUniqueSectionName(
  desiredName: string,
  existingNames: (string | undefined | null)[],
): string {
  let trimmed = (desiredName || "").trim();
  if (!trimmed) trimmed = "Section 1";

  const lowerNames = new Set(
    existingNames
      .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
      .map((n) => n.trim().toLowerCase()),
  );

  if (!lowerNames.has(trimmed.toLowerCase())) {
    return trimmed;
  }

  // Check if desiredName already ends with a space and a number (e.g., "Hero 2" or "Section 1")
  const match = trimmed.match(/^(.*?)(?:\s+(\d+))$/);
  const baseName = match ? match[1]!.trim() : trimmed;
  let counter = match ? parseInt(match[2]!, 10) + 1 : 2;

  while (lowerNames.has(`${baseName} ${counter}`.toLowerCase())) {
    counter++;
  }

  return `${baseName} ${counter}`;
}
