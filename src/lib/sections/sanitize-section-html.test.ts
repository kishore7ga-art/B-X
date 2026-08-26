import assert from "node:assert/strict";
import { describe, it, test } from "node:test";

import {
  sanitizeSectionHtml,
  sanitizeWebsiteConfig,
} from "./sanitize-section-html";

/**
 * The regression suite for the tenant-isolation break these functions close.
 *
 * Every "blocks" case below is a working cross-tenant attack against the
 * platform as it stood: section markup renders with `dangerouslySetInnerHTML` on
 * `webxite.org` and on `<tenant>.webxite.org`, both of which sit inside the
 * `.webxite.org` session cookie scope and inside `isAllowedOrigin`'s CORS
 * allowlist — so script there reads and writes the API as whichever signed-in
 * person is looking at the page, Super Admin included.
 *
 * The "keeps" cases matter just as much. A sanitiser that breaks the section
 * library gets reverted, and then it protects nothing — so the shapes the real
 * templates in `admin-bootstrap.ts` are built from are pinned here.
 */

// --- what must not survive ---------------------------------------------------

test("drops inline event handlers", () => {
  const out = sanitizeSectionHtml('<img src="x" onerror="fetch(1)">');
  assert.ok(!/onerror/i.test(out), out);
});

test("drops a handler separated by a slash rather than whitespace", () => {
  // The regex strip this replaces required \s before `on`, so `/` walked past it.
  const out = sanitizeSectionHtml('<img/onerror="fetch(1)" src=x>');
  assert.ok(!/onerror/i.test(out), out);
});

test("drops a handler split across a newline", () => {
  const out = sanitizeSectionHtml('<img src=x\n  onerror\n  =\n  "fetch(1)">');
  assert.ok(!/onerror/i.test(out), out);
});

test("drops svg animation handlers", () => {
  const out = sanitizeSectionHtml('<svg><animate onbegin="fetch(1)"></svg>');
  assert.ok(!/onbegin/i.test(out), out);
});

test("drops script elements and their contents", () => {
  const out = sanitizeSectionHtml('<div>hi</div><script>fetch("/admin/users")</script>');
  assert.ok(!/<script/i.test(out), out);
  assert.ok(!/admin\/users/.test(out), out);
  assert.match(out, /hi/);
});

test("drops javascript: hrefs", () => {
  const out = sanitizeSectionHtml('<a href="javascript:fetch(1)">go</a>');
  assert.ok(!/javascript:/i.test(out), out);
});

test("drops entity-encoded javascript: hrefs", () => {
  // The old strip compared raw bytes; the browser decodes the entity first.
  const out = sanitizeSectionHtml('<a href="&#106;avascript:fetch(1)">go</a>');
  assert.ok(!/javascript:/i.test(out.replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))), out);
});

test("drops formaction, which the old strip never looked at", () => {
  const out = sanitizeSectionHtml('<button formaction="javascript:fetch(1)">go</button>');
  assert.ok(!/formaction/i.test(out), out);
});

test("drops iframes", () => {
  const out = sanitizeSectionHtml('<iframe src="https://evil.example"></iframe>');
  assert.ok(!/<iframe/i.test(out), out);
});

test("drops object, embed and srcdoc", () => {
  const out = sanitizeSectionHtml(
    '<object data="x"></object><embed src="x"><iframe srcdoc="<script>fetch(1)</script>"></iframe>',
  );
  assert.ok(!/<object|<embed|srcdoc/i.test(out), out);
});

test("neutralises a </style> breakout inside a style block", () => {
  const out = sanitizeSectionHtml("<style>a{}</style><script>fetch(1)</script></style>");
  assert.ok(!/<script/i.test(out), out);
});

test("strips expression() and javascript: from CSS", () => {
  const out = sanitizeSectionHtml("<style>.a{width:expression(alert(1));background:url(javascript:alert(1))}</style>");
  assert.ok(!/expression\s*\(/i.test(out), out);
  assert.ok(!/javascript\s*:/i.test(out), out);
});

test("drops data:text/html hrefs but keeps data: images", () => {
  const link = sanitizeSectionHtml('<a href="data:text/html,<script>fetch(1)</script>">x</a>');
  assert.ok(!/data:text\/html/i.test(link), link);

  const img = sanitizeSectionHtml('<img src="data:image/png;base64,iVBOR">');
  assert.match(img, /data:image\/png/);
});

test("a non-string or empty section becomes an empty string, never passthrough", () => {
  assert.equal(sanitizeSectionHtml(undefined), "");
  assert.equal(sanitizeSectionHtml(null), "");
  assert.equal(sanitizeSectionHtml({ toString: () => "<script>x</script>" }), "");
});

// --- what must survive -------------------------------------------------------

test("keeps the shape of a real library header", () => {
  const header =
    '<header style="background: #0d1527; color: #ffffff; padding: 18px 40px;">' +
    '<div style="display: flex;"><span style="font-weight: 900;">CAMPUS PORTAL</span></div>' +
    '<nav style="display: flex; gap: 24px;">' +
    '<a href="#about" style="color: #cbd5e1;">About</a>' +
    '<a href="#courses" style="color: #cbd5e1;">Academics</a>' +
    "</nav></header>";

  const out = sanitizeSectionHtml(header);
  assert.match(out, /<header/);
  // Whitespace inside `style` is normalised — sanitize-html reparses and
  // reserialises the declarations — so this matches on the declaration rather
  // than on the exact bytes. Every declaration survives; only the spacing moves.
  assert.match(out, /background:\s*#0d1527/);
  assert.match(out, /padding:\s*18px 40px/);
  assert.match(out, /href="#about"/);
  assert.match(out, /CAMPUS PORTAL/);
});

test("keeps inline svg icons", () => {
  const svg =
    '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" fill="#ffffff">' +
    '<path d="M32 4L8 16v18c0 14.5 10.2 26.2 24 30z"/></svg>';
  const out = sanitizeSectionHtml(svg);
  assert.match(out, /<svg/);
  assert.match(out, /viewBox|viewbox/);
  assert.match(out, /<path/);
  assert.match(out, /d="M32 4L8 16v18c0 14\.5 10\.2 26\.2 24 30z"/);
});

test("keeps a style block and hoists it ahead of the markup", () => {
  const out = sanitizeSectionHtml("<style>.hero{color:red}</style><section class=\"hero\">hi</section>");
  assert.ok(out.indexOf("<style>") < out.indexOf("<section"), out);
  assert.match(out, /\.hero\{color:red\}/);
  assert.match(out, /class="hero"/);
});

test("keeps tailwind class names and data attributes", () => {
  const out = sanitizeSectionHtml('<div class="flex gap-4 md:grid" data-xite-slot="hero">x</div>');
  assert.match(out, /class="flex gap-4 md:grid"/);
  assert.match(out, /data-xite-slot="hero"/);
});

test("adds noopener to target=_blank links", () => {
  const out = sanitizeSectionHtml('<a href="https://example.com" target="_blank">x</a>');
  assert.match(out, /rel="noopener noreferrer"/);
});

test("keeps presentational form furniture without an action", () => {
  const out = sanitizeSectionHtml(
    '<form action="https://evil.example"><input type="email" placeholder="Email"><button type="submit">Apply</button></form>',
  );
  assert.match(out, /<form/);
  assert.match(out, /placeholder="Email"/);
  assert.ok(!/action=/i.test(out), out);
});

// --- config-level walk -------------------------------------------------------

test("sanitizeWebsiteConfig cleans every section and preserves structure", () => {
  const config = {
    pages: [
      {
        slug: "/home",
        title: "Home",
        sections: [
          { id: "a", title: "Hero", sortOrder: 0, code: '<div onclick="fetch(1)">hi</div>' },
          { id: "b", title: "CTA", sortOrder: 1, code: "<p>safe</p>" },
        ],
      },
      { slug: "/about", title: "About", sections: [] },
    ],
  };

  const out = sanitizeWebsiteConfig(config);

  assert.equal(out.pages.length, 2);
  assert.equal(out.pages[0]!.slug, "/home");
  assert.equal(out.pages[0]!.sections.length, 2);
  // Metadata beside `code` is carried through untouched.
  assert.equal(out.pages[0]!.sections[0]!.id, "a");
  assert.equal(out.pages[0]!.sections[0]!.sortOrder, 0);
  assert.ok(!/onclick/i.test(out.pages[0]!.sections[0]!.code));
  assert.match(out.pages[0]!.sections[0]!.code, /hi/);
  assert.match(out.pages[0]!.sections[1]!.code, /<p>safe<\/p>/);
});

test("sanitizeWebsiteConfig leaves a config it does not understand alone", () => {
  assert.equal(sanitizeWebsiteConfig(null), null);
  assert.deepEqual(sanitizeWebsiteConfig({ pages: "nope" }), { pages: "nope" });
});

/**
 * Config sanitisation over a Mongoose document.
 *
 * Spreading a Mongoose subdocument copies its internals rather than its fields,
 * because the fields are prototype getters over `_doc`. Everything in
 * `sanitizeWebsiteConfig` rebuilds objects by spreading, so a page arrived
 * carrying `__parentArray` and `_doc` and no `slug`.
 *
 * It survived only because nothing read a page's slug. The moment published
 * sites gained per-page URLs, `/about` on a real tenant returned 404 while the
 * platform default — a plain object, never a document — worked perfectly.
 */
describe("sanitizeWebsiteConfig — a stored config, whatever shape it arrives in", () => {
  /** The shape Mongoose hands back: fields behind getters, values in `_doc`. */
  function asMongooseDoc<T extends Record<string, unknown>>(fields: T) {
    return {
      _doc: fields,
      $__: {},
      $isNew: false,
      __parentArray: [],
      toObject: () => ({ ...fields }),
    };
  }

  it("keeps a page's slug and title when the page is a document", () => {
    const config = {
      pages: [
        asMongooseDoc({ slug: "/home", title: "Home", sections: [{ id: "a", code: "<p>hi</p>" }] }),
        asMongooseDoc({ slug: "/about", title: "About", sections: [] }),
      ],
    };

    const out = sanitizeWebsiteConfig(config) as unknown as {
      pages: { slug?: string; title?: string; sections: unknown[] }[];
    };

    assert.deepEqual(out.pages.map((p) => p.slug), ["/home", "/about"]);
    assert.deepEqual(out.pages.map((p) => p.title), ["Home", "About"]);
  });

  it("does not leak Mongoose internals into the response", () => {
    const config = { pages: [asMongooseDoc({ slug: "/home", sections: [] })] };
    const out = sanitizeWebsiteConfig(config) as unknown as { pages: Record<string, unknown>[] };
    for (const key of ["__parentArray", "$__", "_doc", "$isNew"]) {
      assert.ok(!(key in out.pages[0]!), `${key} leaked into the sanitised page`);
    }
  });

  it("still sanitises the markup inside a document's sections", () => {
    const config = {
      pages: [
        asMongooseDoc({
          slug: "/home",
          sections: [asMongooseDoc({ id: "a", code: '<img src=x onerror="alert(1)">' })],
        }),
      ],
    };
    const out = sanitizeWebsiteConfig(config) as unknown as { pages: { sections: { code: string }[] }[] };
    assert.ok(!out.pages[0]!.sections[0]!.code.includes("onerror"));
  });

  it("leaves a plain config exactly as it was", () => {
    const config = { pages: [{ slug: "/home", title: "Home", sections: [] }] };
    const out = sanitizeWebsiteConfig(config) as { pages: { slug: string }[] };
    assert.equal(out.pages[0]!.slug, "/home");
  });
});
