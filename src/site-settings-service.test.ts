import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_CUSTOM_CODE_BYTES,
  mayExecuteCustomCode,
  stripExecutable,
  __testing,
} from "@/site-settings-service";

const { withDefaults, clampString, clampCode } = __testing;

describe("mayExecuteCustomCode — script only on a tenant's own domain", () => {
  it("is false with no domains at all", () => {
    assert.equal(mayExecuteCustomCode({ domains: [] }), false);
    assert.equal(mayExecuteCustomCode({ domains: null }), false);
    assert.equal(mayExecuteCustomCode({}), false);
  });

  // Adding a domain must not be enough. Until it is ACTIVE the tenant is still
  // being served on a hostname inside the platform's cookie scope.
  it("is false while a domain is only pending or verified", () => {
    assert.equal(mayExecuteCustomCode({ domains: [{ status: "PENDING_VERIFICATION" }] }), false);
    assert.equal(mayExecuteCustomCode({ domains: [{ status: "VERIFIED" }] }), false);
    assert.equal(mayExecuteCustomCode({ domains: [{ status: "FAILED" }] }), false);
  });

  it("is true once a domain is active", () => {
    assert.equal(mayExecuteCustomCode({ domains: [{ status: "ACTIVE" }] }), true);
    assert.equal(
      mayExecuteCustomCode({ domains: [{ status: "PENDING_VERIFICATION" }, { status: "ACTIVE" }] }),
      true,
    );
  });
});

/**
 * These are the cases that decide whether a tenant's markup can attack the
 * platform's own cookie scope, so they are enumerated rather than sampled.
 */
describe("stripExecutable — what a platform subdomain is allowed to render", () => {
  /**
   * These assert behaviour rather than bytes.
   *
   * They used to compare the output string exactly, which worked while this was
   * five regexes over the input and every surviving byte came through
   * untouched. It is `sanitize-html` now — a parser — so void elements come back
   * self-closing (`<meta />`) and `style` attributes come back with their CSS
   * reserialised. The markup is equivalent; the bytes are not, and pinning the
   * bytes would pin the implementation rather than the security property.
   *
   * What each case actually needs to prove is "the executable part is gone and
   * the inert part is still there", so that is what is checked.
   */
  const hasNoScript = (html: string) => !/<script|onerror|onclick|onload|javascript:/i.test(html);

  it("removes a script element and its contents", () => {
    assert.equal(stripExecutable('<script>alert(1)</script>'), "");

    const out = stripExecutable('<meta name="a"><script>steal()</script><meta name="b">');
    assert.ok(hasNoScript(out), out);
    assert.ok(!/steal/.test(out), out);
    assert.match(out, /<meta name="a"/);
    assert.match(out, /<meta name="b"/);
  });

  it("removes a script with attributes", () => {
    assert.equal(stripExecutable('<script src="https://evil.example/x.js" async></script>'), "");
    assert.equal(stripExecutable('<SCRIPT TYPE="text/javascript">x()</SCRIPT>'), "");
  });

  // An unclosed tag would otherwise survive the regex and still execute once
  // the browser's parser closed it.
  it("removes an unclosed script", () => {
    assert.equal(stripExecutable('<script>alert(1)'), "");
  });

  it("removes embedding elements that can host another origin", () => {
    assert.equal(stripExecutable('<iframe src="https://evil.example"></iframe>'), "");
    assert.equal(stripExecutable('<object data="x"></object>'), "");
    assert.equal(stripExecutable('<embed src="x">'), "");
  });

  it("removes inline event handlers", () => {
    const img = stripExecutable('<img src="x" onerror="steal()">');
    assert.ok(hasNoScript(img), img);
    assert.match(img, /src="x"/);

    assert.equal(stripExecutable("<div onclick='go()'>hi</div>"), "<div>hi</div>");

    // `<body>` is not on the allowlist at all — head and body-end code has no
    // business carrying one — so it goes entirely rather than being emptied.
    assert.equal(stripExecutable('<body onload=go()>'), "");
  });

  /**
   * These two are the bypasses the regex version admitted. `/` is a valid
   * attribute separator, so `\son` never matched; and the scheme check ran
   * against raw bytes while the browser decodes entities first.
   */
  it("removes handlers that a whitespace-anchored regex misses", () => {
    const slash = stripExecutable('<img/onerror="steal()" src=x>');
    assert.ok(hasNoScript(slash), slash);

    const newline = stripExecutable('<img src=x\n  onerror\n  =\n  "steal()">');
    assert.ok(hasNoScript(newline), newline);
  });

  it("removes javascript: and data: URLs", () => {
    assert.equal(stripExecutable('<a href="javascript:alert(1)">x</a>'), "<a>x</a>");

    const entity = stripExecutable('<a href="&#106;avascript:alert(1)">x</a>');
    assert.equal(entity, "<a>x</a>");

    const dataImg = stripExecutable('<img src="data:text/html;base64,PHNjcmlwdD4=">');
    assert.ok(!/data:/i.test(dataImg), dataImg);
  });

  // The point of stripping rather than escaping: the tenant asked for markup,
  // and the harmless majority of it should still work.
  it("keeps markup that cannot execute", () => {
    const meta = stripExecutable('<meta name="google-site-verification" content="abc123">');
    assert.match(meta, /name="google-site-verification"/);
    assert.match(meta, /content="abc123"/);

    const styles = stripExecutable('<link rel="stylesheet" href="https://fonts.example/f.css">');
    assert.match(styles, /rel="stylesheet"/);
    assert.match(styles, /href="https:\/\/fonts\.example\/f\.css"/);

    /**
     * The CSS body specifically, because this is the case the parser would
     * otherwise silently eat: sanitize-html drops the text content of a `<style>`
     * element even when the tag is allowed, so the block is lifted out before
     * sanitisation and reattached after.
     */
    assert.equal(stripExecutable("<style>.a{color:red}</style>"), "<style>.a{color:red}</style>");
  });

  it("keeps a stylesheet but strips CSS that reaches outside CSS", () => {
    const out = stripExecutable("<style>.a{color:red;width:expression(alert(1))}</style>");
    assert.match(out, /color:red/);
    assert.ok(!/expression\s*\(/i.test(out), out);
  });

  it("handles empty input", () => {
    assert.equal(stripExecutable(null), "");
    assert.equal(stripExecutable(undefined), "");
    assert.equal(stripExecutable(""), "");
  });
});

describe("withDefaults", () => {
  it("supplies a complete object from nothing", () => {
    const settings = withDefaults(null);
    assert.equal(settings.seo.indexingEnabled, true);
    assert.equal(settings.maintenance.enabled, false);
    assert.equal(settings.customCode.headHtml, null);
  });

  // Indexing defaults to on, so an existing tenant is not silently
  // de-indexed by the arrival of a field they never set.
  it("preserves values that were set", () => {
    const settings = withDefaults({
      seo: { indexingEnabled: false, title: "T", description: null },
      maintenance: { enabled: true, message: "Back soon" },
      customCode: { headHtml: "<meta>", bodyEndHtml: null },
    } as never);
    assert.equal(settings.seo.indexingEnabled, false);
    assert.equal(settings.seo.title, "T");
    assert.equal(settings.maintenance.message, "Back soon");
    assert.equal(settings.customCode.headHtml, "<meta>");
  });
});

describe("validation", () => {
  it("clampString trims, nulls empties, and rejects over-length", () => {
    assert.equal(clampString("  hello  ", 10, "Field"), "hello");
    assert.equal(clampString("", 10, "Field"), null);
    assert.equal(clampString(null, 10, "Field"), null);
    assert.throws(() => clampString("x".repeat(11), 10, "Field"), /too long/);
    assert.throws(() => clampString(42, 10, "Field"), /must be text/);
  });

  it("clampCode measures bytes, not characters", () => {
    // Four-byte characters: 6000 of them is 24000 bytes, over the limit, while
    // being only 6000 characters. A character-based check would let it through.
    const emoji = "\u{1F600}".repeat(6000);
    assert.ok(emoji.length < MAX_CUSTOM_CODE_BYTES);
    assert.throws(() => clampCode(emoji, "Header code"), /too large/);
  });

  it("clampCode accepts code within the limit", () => {
    assert.equal(clampCode("<meta name=x>", "Header code"), "<meta name=x>");
    assert.equal(clampCode("   ", "Header code"), null);
  });
});

/**
 * Location and answer-engine settings.
 *
 * Both end up in a `<meta>` tag or a JSON-LD node on a published site, so the
 * question every case below asks is the same one: can a value get out of here
 * that a consumer would have to discard, or that would mean something other
 * than what the tenant typed?
 */
describe("normalizeGeo — a place, or nothing", () => {
  const { normalizeGeo } = __testing;

  it("is null for nothing at all", () => {
    assert.equal(normalizeGeo(null), null);
    assert.equal(normalizeGeo(undefined), null);
  });

  it("is null for a form the tenant emptied", () => {
    // An object of blanks would make "this site has a location" true for a site
    // that has none, and the renderer keys the whole geo block on that.
    assert.equal(normalizeGeo({ streetAddress: "", locality: "  ", serviceAreas: [] }), null);
  });

  it("keeps the parts of an address separately", () => {
    const geo = normalizeGeo({
      streetAddress: " 12 Anna Salai ",
      locality: "Chennai",
      region: "IN-TN",
      postalCode: "600002",
      country: "in",
    });
    assert.equal(geo?.streetAddress, "12 Anna Salai");
    assert.equal(geo?.locality, "Chennai");
    assert.equal(geo?.country, "IN");
  });

  it("refuses a country that is not a country code", () => {
    assert.throws(() => normalizeGeo({ country: "India" }), /two-letter country code/);
  });

  it("refuses a coordinate outside the world", () => {
    assert.throws(() => normalizeGeo({ latitude: 100, longitude: 0 }), /between -90 and 90/);
    assert.throws(() => normalizeGeo({ latitude: 0, longitude: 200 }), /between -180 and 180/);
  });

  it("refuses half a coordinate", () => {
    // One of the pair locates nothing, and emitted alone it produces an ICBM tag
    // and a GeoCoordinates node a consumer has to throw away.
    assert.throws(() => normalizeGeo({ latitude: 13.08 }), /both a latitude and a longitude/);
    assert.throws(() => normalizeGeo({ longitude: 80.27 }), /both a latitude and a longitude/);
  });

  it("takes a coordinate typed as text", () => {
    const geo = normalizeGeo({ latitude: "13.0827", longitude: "80.2707" });
    assert.equal(geo?.latitude, 13.0827);
    assert.equal(geo?.longitude, 80.2707);
  });

  it("refuses a coordinate that is not a number", () => {
    assert.throws(() => normalizeGeo({ latitude: "north", longitude: "east" }), /must be a number/);
  });

  it("caps how many service areas one site may claim", () => {
    assert.throws(
      () => normalizeGeo({ serviceAreas: Array.from({ length: 50 }, (_, i) => `Area ${i}`) }),
      /at most 20 entries/i,
    );
  });
});

describe("normalizeAeo — facts a machine can quote", () => {
  const { normalizeAeo } = __testing;

  it("is null for nothing at all", () => {
    assert.equal(normalizeAeo(null), null);
    assert.equal(normalizeAeo({ sameAs: [], faqs: [] }), null);
  });

  it("refuses an organisation type that is not a schema.org type", () => {
    // An arbitrary `@type` produces structured data that validates as nothing,
    // and a consumer discards the whole block rather than the one bad field.
    assert.throws(() => normalizeAeo({ organizationType: "Bakery" }), /must be one of/);
  });

  it("accepts the types this platform's tenants actually are", () => {
    assert.equal(normalizeAeo({ organizationType: "School" })?.organizationType, "School");
  });

  it("refuses a founding year that has not happened", () => {
    const nextYear = new Date().getFullYear() + 1;
    assert.throws(() => normalizeAeo({ foundingYear: nextYear }), /whole year between/);
    assert.throws(() => normalizeAeo({ foundingYear: 1.5 }), /whole year between/);
  });

  it("refuses a profile link that is not a web address", () => {
    // `sameAs` is followed. A `javascript:` URL there is script execution.
    assert.throws(
      () => normalizeAeo({ sameAs: ["javascript:alert(1)"] }),
      /http or https|full web address/,
    );
    assert.throws(() => normalizeAeo({ sameAs: ["/relative"] }), /full web address/);
  });

  it("keeps a real profile link", () => {
    assert.deepEqual(normalizeAeo({ sameAs: ["https://example.edu/"] })?.sameAs, [
      "https://example.edu/",
    ]);
  });

  it("drops a question with no answer rather than emitting an invalid FAQ", () => {
    const aeo = normalizeAeo({
      faqs: [
        { question: "What are the fees?", answer: "80,000 a year." },
        { question: "Is there a hostel?", answer: "" },
        { question: "", answer: "Yes." },
      ],
    });
    assert.equal(aeo?.faqs?.length, 1);
    assert.equal(aeo?.faqs?.[0]?.question, "What are the fees?");
  });

  it("caps how many questions one site may publish", () => {
    assert.throws(
      () =>
        normalizeAeo({
          faqs: Array.from({ length: 50 }, (_, i) => ({ question: `Q${i}`, answer: `A${i}` })),
        }),
      /At most 30 questions/,
    );
  });
});

describe("clampUrl — anything that reaches a meta tag or a link", () => {
  const { clampUrl } = __testing;

  it("passes an ordinary https address through", () => {
    assert.equal(clampUrl("https://cdn.example.com/og.png", "Image"), "https://cdn.example.com/og.png");
  });

  it("refuses a scheme that executes", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "vbscript:x"]) {
      assert.throws(() => clampUrl(bad, "Image"), /http or https|full web address/, `for ${bad}`);
    }
  });

  it("refuses a relative path, which would resolve on whichever host renders", () => {
    assert.throws(() => clampUrl("/images/og.png", "Image"), /full web address/);
  });

  it("is null for nothing", () => {
    assert.equal(clampUrl("", "Image"), null);
    assert.equal(clampUrl(null, "Image"), null);
  });
});
