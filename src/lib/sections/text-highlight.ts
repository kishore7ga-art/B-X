/**
 * Alternating word styling logic for headers, paragraphs, and sections.
 *
 * Applies alternating colors (Color 1 -> Color 2 -> Color 1 -> Color 2)
 * directly to words using <span> elements while preserving inner HTML tags,
 * typography, whitespace, and layout.
 */

export interface AlternatingWordOptions {
  colors: [string, string];
}

/**
 * Wraps individual words in alternating <span> elements with Color 1 -> Color 2.
 * Preserves existing tags (like <br />, <strong>, etc.) and whitespace.
 */
export function formatAlternatingWords(
  textOrHtml: string,
  colors: [string, string] = ["#ffffff", "#38bdf8"],
): string {
  // Split into tokens of HTML tags vs text nodes
  const parts = textOrHtml.split(/(<[^>]+>)/g);
  let wordIndex = 0;

  const result = parts.map((part) => {
    // If it's a tag (e.g. <br />, <span>, </span>), return untouched
    if (part.startsWith("<") && part.endsWith(">")) {
      return part;
    }

    // Split words while preserving whitespace
    return part.replace(/\S+/g, (word) => {
      const color = colors[wordIndex % 2];
      wordIndex++;
      return `<span style="color: ${color};">${word}</span>`;
    });
  });

  return result.join("");
}

/**
 * Modifies <h1> and <p> elements in a section's HTML to apply alternating word colors.
 * Preserves the exact same layout, typography, line-height, and structure.
 */
export function applyAlternatingSectionTextColors(
  sectionHtml: string,
  options: {
    h1Colors?: [string, string];
    pColors?: [string, string];
  } = {},
): string {
  const h1Colors = options.h1Colors || ["#ffffff", "#38bdf8"];
  const pColors = options.pColors || ["#cbd5e1", "#fbbf24"];

  let out = sectionHtml;

  // Process <h1>
  out = out.replace(/(<h1[^>]*>)([\s\S]*?)(<\/h1>)/gi, (_match, openTag, innerHtml, closeTag) => {
    if (innerHtml.includes("<span style=\"color:")) {
      return `${openTag}${innerHtml}${closeTag}`;
    }
    const styled = formatAlternatingWords(innerHtml, h1Colors);
    return `${openTag}${styled}${closeTag}`;
  });

  // Process <p>
  out = out.replace(/(<p[^>]*>)([\s\S]*?)(<\/p>)/gi, (_match, openTag, innerHtml, closeTag) => {
    if (innerHtml.includes("<span style=\"color:")) {
      return `${openTag}${innerHtml}${closeTag}`;
    }
    const styled = formatAlternatingWords(innerHtml, pColors);
    return `${openTag}${styled}${closeTag}`;
  });

  return out;
}
