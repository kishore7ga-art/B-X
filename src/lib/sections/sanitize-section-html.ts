import sanitizeHtml from "sanitize-html";

/**
 * Making a tenant's section markup safe to put on a page this platform owns.
 *
 * A section is stored as a raw HTML string and rendered with
 * `dangerouslySetInnerHTML` — in `PreviewSiteViewer` for the published site and
 * the preview, in `EditorStudio` for the canvas. Nothing sanitised it anywhere
 * along that path: `PUT /api/v1/my-website` accepted whatever JSON it was sent
 * and `sectionCanvasHtml()` shuffled `<style>` and `<link>` into the head and
 * injected the rest verbatim.
 *
 * Why that is not merely "tenants can break their own site".
 *
 * `xite-F` serves a tenant's published sections from three origins, and two of
 * them are not the tenant's:
 *
 *   - `<tenant>.webxite.org`, via the proxy rewrite;
 *   - `webxite.org/site/<tenant>` and `webxite.org/preview/<tenant>` and
 *     `webxite.org/<tenant>` — the platform apex, the same origin as the sign-in
 *     page and the editor.
 *
 * The session cookie is scoped to `.webxite.org` and is `SameSite=None`;
 * `isAllowedOrigin` in server.ts admits every `*.webxite.org` origin for
 * credentialed CORS; and `next.config.ts` rewrites `webxite.org/admin/*`
 * straight onto the admin API. So one `<img src=x onerror=...>` in a section
 * runs inside the platform's own cookie scope, inside its CORS allowlist, and —
 * on the apex — same-origin with the admin proxy, needing no CORS at all. A
 * Super Admin opening a tenant's site to check it, which is the ordinary reason
 * anyone opens one, hands that script `GET /admin/users`,
 * `PATCH /admin/users/:id/password` and `DELETE /admin/users/:id`.
 *
 * `site-settings-service.ts` already reasons this through for the `customCode`
 * field and refuses to execute script on a platform subdomain for exactly these
 * reasons. Section markup is the same input arriving through a different door,
 * and it had none of the same protection.
 *
 * What survives sanitisation is everything a section actually is: layout tags,
 * inline `style`, classes, ids, data attributes, images, links, SVG, and its own
 * `<style>` block. What does not is everything that executes.
 */

/**
 * `<style>` blocks, kept out of sanitize-html's way.
 *
 * sanitize-html removes the *text content* of a `<style>` element even when the
 * tag is allowed — it has no CSS parser, and dropping the body is the safe
 * default. Sections carry their whole stylesheet in there, so it is lifted out
 * first, checked separately, and put back.
 */
const STYLE_BLOCK = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;

/**
 * CSS that can reach outside CSS.
 *
 * A short list on purpose. `expression()` is IE-era script-in-CSS; `javascript:`
 * and `vbscript:` in a `url()` are the same idea with a different spelling;
 * `-moz-binding` loaded XBL. `behavior` is the IE `.htc` equivalent. None of
 * these have a legitimate use in a section stylesheet, and stripping the
 * declaration rather than the whole block keeps the rest of the tenant's design.
 */
const DANGEROUS_CSS =
  /(expression\s*\(|javascript\s*:|vbscript\s*:|-moz-binding\s*:|behavior\s*:)/gi;

/**
 * A `</style` sequence inside CSS closes the element early and drops the browser
 * back into HTML parsing — which is how a stylesheet becomes a script tag. It
 * cannot appear in valid CSS, so neutralising it costs nothing.
 */
export function safeCss(css: string): string {
  return css
    .replace(/<\/\s*style/gi, "<\\/style")
    .replace(DANGEROUS_CSS, "/* removed */");
}

import { SVG_ATTRIBUTES, SVG_TAGS } from "@/lib/sections/svg-allowlist";

const ALLOWED_TAGS = [
  // Structure
  "div", "span", "section", "header", "footer", "nav", "main", "aside",
  "article", "figure", "figcaption", "details", "summary", "hr", "br",
  // Text
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "blockquote", "pre", "code",
  "strong", "b", "em", "i", "u", "s", "small", "sub", "sup", "mark", "time",
  "abbr", "address", "cite", "q", "kbd", "samp", "var", "wbr",
  // Lists
  "ul", "ol", "li", "dl", "dt", "dd",
  // Tables
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
  "colgroup", "col",
  // Media and links
  "a", "img", "picture", "source", "video", "audio", "track",
  // Presentational form furniture. These render, and a section's "Apply Now"
  // box is often built out of them; none of them submit anywhere, because
  // `action` and `formaction` are not allowed attributes below.
  "form", "label", "input", "textarea", "select", "option", "optgroup",
  "button", "fieldset", "legend", "progress", "meter",
  // Inline SVG, which is how every icon and logo in the library is drawn.
  // From the shared list, so this policy and the Admin template policy cannot
  // disagree about what an SVG is — they did, and a crest rendered one way in
  // the Admin preview and another way live.
  ...SVG_TAGS,
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern",
  "filter", "feGaussianBlur", "feOffset", "feMerge", "feMergeNode",
  "feColorMatrix", "feBlend", "feFlood", "feComposite",
  // Reattached after sanitisation, but listed so a nested one is not dropped
  // in a way that changes the document shape.
  "style",
];

/**
 * Attributes, by name, with no wildcard for `on*`.
 *
 * sanitize-html drops any attribute not named here, so event handlers go
 * without needing to be enumerated — including the spellings a regex strip
 * misses, such as `<img/onerror=...>` where `/` separates the attribute instead
 * of a space, and `onerror` written across a newline.
 */
const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  "*": [
    "style", "class", "id", "title", "role", "dir", "lang", "hidden",
    "aria-*", "data-*",
    // SVG presentation, geometry, paint servers and masking. Shared with the
    // template policy: an allowlist that keeps `<path>` but drops `fill-rule`
    // renders a social icon inside out, because that attribute is what makes
    // the hole in a glyph a hole.
    ...SVG_ATTRIBUTES,
  ],
  a: ["href", "target", "rel", "download", "name"],
  img: ["src", "srcset", "sizes", "alt", "loading", "decoding", "width", "height"],
  source: ["src", "srcset", "sizes", "type", "media"],
  video: ["src", "poster", "controls", "autoplay", "loop", "muted", "playsinline", "preload", "width", "height"],
  audio: ["src", "controls", "loop", "muted", "preload"],
  track: ["src", "kind", "srclang", "label", "default"],
  // Deliberately no `action` and no `formaction`: `formaction="javascript:..."`
  // is an execution sink that never looks like one, and a section's form has
  // nowhere legitimate to post to in the first place.
  input: ["type", "name", "value", "placeholder", "checked", "disabled", "readonly", "required", "min", "max", "step", "maxlength", "pattern", "autocomplete"],
  textarea: ["name", "placeholder", "rows", "cols", "disabled", "readonly", "maxlength"],
  select: ["name", "multiple", "disabled", "required", "size"],
  option: ["value", "selected", "disabled", "label"],
  button: ["type", "disabled", "name", "value"],
  label: ["for"],
  progress: ["value", "max"],
  meter: ["value", "min", "max", "low", "high", "optimum"],
  td: ["colspan", "rowspan", "headers", "scope"],
  th: ["colspan", "rowspan", "headers", "scope", "abbr"],
  col: ["span"],
  colgroup: ["span"],
  time: ["datetime"],
  use: ["href", "xlink:href"],
  style: ["media"],
};

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTRIBUTES,
  /**
   * No `javascript:`, and no `data:` outside images.
   *
   * `data:text/html` in an `href` is a same-document navigation into markup the
   * tenant wrote; `data:image/svg+xml` in an `href` is the same thing wearing an
   * image's name. Images keep `data:` because inline thumbnails are common and
   * an `<img>` context does not execute script whatever the bytes say.
   */
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  allowedSchemesAppliedToAttributes: ["href", "src", "srcset", "cite", "poster"],
  allowProtocolRelative: true,
  /**
   * `target="_blank"` without `rel="noopener"` hands the opened page a
   * `window.opener` reference back to ours. Modern browsers imply it, older ones
   * and some in-app webviews do not, and adding it is free.
   */
  transformTags: {
    a: (tagName, attribs) => {
      const next: Record<string, string> = { ...attribs };
      if (next.target === "_blank") next.rel = "noopener noreferrer";
      return { tagName, attribs: next };
    },
  },
  // `<style>` bodies are handled by the extract/reattach pass below; anything
  // that reaches sanitize-html inside one is markup, not CSS, and goes.
  nonTextTags: ["script", "textarea", "noscript", "iframe", "object", "embed"],
  disallowedTagsMode: "discard",
};

/**
 * Sanitises one section's markup.
 *
 * Never throws. A section that cannot be parsed is replaced with nothing rather
 * than passed through — the caller is a render path, and "leave it as it was" is
 * the failure mode this function exists to remove.
 */
export function sanitizeSectionHtml(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return "";

  try {
    const styles: string[] = [];

    // Lift <style> out, keeping each block's CSS after a safety pass.
    const withoutStyles = raw.replace(STYLE_BLOCK, (_full, attrs: string, css: string) => {
      if (!css.trim()) return "";
      // The opening tag's attributes are dropped rather than sanitised: the only
      // one that matters is `media`, and a section has never needed it.
      const preserved = /data-xite-auto-responsive/i.test(attrs)
        ? `<style data-xite-auto-responsive>${safeCss(css)}</style>`
        : `<style>${safeCss(css)}</style>`;
      styles.push(preserved);
      return "";
    });

    const cleaned = sanitizeHtml(withoutStyles, OPTIONS);

    // Stylesheets first, exactly as `extractStylesAndBody` in xite-F expects to
    // find them — it pulls them back out and moves them into document.head.
    return [...styles, cleaned].filter(Boolean).join("\n");
  } catch (error) {
    console.error("[sections] sanitize failed, dropping section markup:", (error as Error).message);
    return "";
  }
}

/** One page's sections, sanitised in place. Shape and ordering are untouched. */
function sanitizeSections(sections: unknown): unknown {
  if (!Array.isArray(sections)) return sections;
  return sections.map((section) => {
    if (!section || typeof section !== "object") return section;
    const entry = section as Record<string, unknown>;
    if (typeof entry.code !== "string") return entry;
    return { ...entry, code: sanitizeSectionHtml(entry.code) };
  });
}

/**
 * A whole website config, sanitised.
 *
 * Applied on the way in (so a draft is stored clean) *and* on the way out (so
 * the markup already sitting in every tenant's `websiteConfig` and
 * `publishedConfig` from before this existed is cleaned before it reaches a
 * browser). Sanitising only on write would have left every existing site
 * exploitable until its owner next pressed save.
 */
export function sanitizeWebsiteConfig<T>(config: T): T {
  if (!config || typeof config !== "object") return config;

  const source = config as Record<string, unknown>;
  if (!Array.isArray(source.pages)) return config;

  return {
    ...source,
    pages: source.pages.map((page) => {
      if (!page || typeof page !== "object") return page;
      const entry = page as Record<string, unknown>;
      return { ...entry, sections: sanitizeSections(entry.sections) };
    }),
  } as T;
}

