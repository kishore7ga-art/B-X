/**
 * What an inline SVG needs to survive sanitising, in one list.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Every logo and icon in the section library is inline SVG, and both sanitisers
 * kept their own partial list of what an SVG is allowed to contain. Neither was
 * complete, and the failure is silent by construction: a list that keeps `<svg>`
 * and `<path>` but drops `<clipPath>`, `<linearGradient>`, `fill-rule` and
 * `transform` does not throw and does not blank the element. It renders the
 * crest as broken line-art — recognisably the same shape, visibly wrong — and
 * turns a social icon inside out, because `fill-rule="evenodd"` is what makes
 * the hole in a glyph a hole.
 *
 * That is the hardest kind of bug to report, because the page still looks like
 * a page. It took a side-by-side screenshot of the same navbar to see it.
 *
 * ── Why it is shared ───────────────────────────────────────────────────────
 *
 * Admin templates and tenant-saved sections go through different sanitisers,
 * deliberately — they disagree about `<script>`. They must not also disagree
 * about what an SVG is, or a logo renders one way in the Admin's preview and
 * another way on the live site, which is precisely what happened.
 *
 * ── What is deliberately absent ────────────────────────────────────────────
 *
 * `<foreignObject>` — it embeds arbitrary HTML inside an SVG, which is a way
 * back into HTML parsing and therefore into script. `<script>` and `<style>`
 * are not here either; each sanitiser decides those for itself.
 *
 * Nothing in these lists can execute. `href` and `xlink:href` are still subject
 * to each sanitiser's `allowedSchemes`, so `javascript:` remains impossible.
 */

/**
 * Element names, in both spellings — and the camelCase one is the load-bearing
 * half.
 *
 * sanitize-html lower-cases **attribute** names but preserves **tag** names, so
 * `<clipPath>` arrives as `clipPath` and an allowlist spelled `clippath`
 * matches nothing at all. Verified rather than assumed: with only the lowercase
 * forms allowed, `<linearGradient>` and `<clipPath>` are discarded and their
 * children hoisted into `<defs>` — which is a gradient that never paints and a
 * mask that never clips, on an element that still renders.
 *
 * Both spellings are listed because that asymmetry is a property of one library
 * version, and the cost of being wrong about it is a logo that looks *nearly*
 * right.
 */
export const SVG_TAGS = [
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  // Shapes
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
  // Text
  "text",
  "tspan",
  "textpath",
  "textPath",
  // Paint servers and masking
  "lineargradient",
  "linearGradient",
  "radialgradient",
  "radialGradient",
  "stop",
  "pattern",
  "clippath",
  "clipPath",
  "mask",
  "marker",
  "image",
  // Filters. Common in logos for a drop shadow, and inert.
  "filter",
  "fegaussianblur",
  "feGaussianBlur",
  "feoffset",
  "feOffset",
  "feblend",
  "feBlend",
  "fecolormatrix",
  "feColorMatrix",
  "fecomposite",
  "feComposite",
  "feflood",
  "feFlood",
  "femerge",
  "feMerge",
  "femergenode",
  "feMergeNode",
  "fedropshadow",
  "feDropShadow",
] as const;

/**
 * Attributes, in both spellings.
 *
 * The same lower-casing applies, and the camelCase forms are kept beside the
 * lowercase ones so this list is correct whichever way a parser hands them over
 * — the existing code already did this for `viewBox`/`viewbox`, for the same
 * reason.
 */
export const SVG_ATTRIBUTES = [
  // Document and viewport
  "xmlns",
  "xmlns:xlink",
  "version",
  "viewBox",
  "viewbox",
  "preserveAspectRatio",
  "preserveaspectratio",
  "width",
  "height",
  "overflow",

  // Geometry
  "d",
  "points",
  "pathLength",
  "pathlength",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "dx",
  "dy",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "rotate",

  // Paint — `fill-rule` and `clip-rule` decide whether a glyph has a hole in it
  "fill",
  "fill-rule",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-opacity",
  "opacity",
  "color",
  "paint-order",
  "vector-effect",
  "shape-rendering",
  "visibility",
  "display",

  // Text
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "letter-spacing",
  "word-spacing",
  "text-anchor",
  "text-decoration",
  "dominant-baseline",
  "alignment-baseline",
  "baseline-shift",
  "textLength",
  "textlength",
  "lengthAdjust",
  "lengthadjust",

  // Transforms
  "transform",
  "transform-origin",
  "gradientTransform",
  "gradienttransform",
  "patternTransform",
  "patterntransform",

  // References — still subject to allowedSchemes, so no javascript:
  "href",
  "xlink:href",
  "clip-path",
  "clip-rule",
  "mask",
  "filter",
  "marker-start",
  "marker-mid",
  "marker-end",

  // Gradients and patterns
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientUnits",
  "gradientunits",
  "spreadMethod",
  "spreadmethod",
  "patternUnits",
  "patternunits",
  "patternContentUnits",
  "patterncontentunits",
  "clipPathUnits",
  "clippathunits",
  "maskUnits",
  "maskunits",
  "maskContentUnits",
  "maskcontentunits",

  // Filter primitives
  "filterUnits",
  "filterunits",
  "primitiveUnits",
  "primitiveunits",
  "in",
  "in2",
  "result",
  "stdDeviation",
  "stddeviation",
  "mode",
  "type",
  "values",
  "operator",
  "flood-color",
  "flood-opacity",
] as const;

/**
 * Elements that must never be allowed inside an SVG, whatever else is.
 *
 * Listed rather than merely omitted so a future edit that widens the tag list
 * has something to check against — and so the reason is written down next to
 * the name.
 */
export const SVG_FORBIDDEN_TAGS = [
  // Embeds arbitrary HTML inside SVG: a route back into HTML parsing, and from
  // there into script.
  "foreignobject",
  // Loads and runs an external document.
  "script",
  // Declarative animation that can set arbitrary attributes over time,
  // including ones this list would otherwise refuse.
  "set",
  "animate",
  "animatetransform",
  "animatemotion",
] as const;
