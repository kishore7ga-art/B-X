/**
 * The HTML for `/docs`, rendered from `/openapi.json` in the browser.
 *
 * Self-contained on purpose: no Swagger UI, no CDN script. A documentation page
 * that fetches its renderer from someone else's domain is a page that goes
 * blank when that domain is blocked, slow or gone — and it would be the only
 * thing this service serves that depends on a third party at all. The spec is
 * still standard OpenAPI 3.1 at `/openapi.json`, so anyone who prefers Swagger
 * UI, Redoc or Scalar can point it at that.
 */
export const docsPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>XITE API</title>
<style>
  :root {
    --bg: #ffffff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb;
    --panel: #f9fafb; --code: #f3f4f6;
    --get: #0d9488; --post: #2563eb; --patch: #b45309; --delete: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0f17; --fg: #e5e7eb; --muted: #9ca3af; --line: #1f2937;
      --panel: #111827; --code: #0f172a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 40px 20px 96px; }
  h1 { font-size: 30px; margin: 0 0 6px; letter-spacing: -0.02em; }
  .desc { color: var(--muted); white-space: pre-wrap; margin: 0 0 28px; }
  h2 {
    font-size: 13px; text-transform: uppercase; letter-spacing: .12em;
    color: var(--muted); margin: 40px 0 12px; padding-bottom: 8px;
    border-bottom: 1px solid var(--line);
  }
  .op {
    border: 1px solid var(--line); border-radius: 10px;
    margin-bottom: 10px; overflow: hidden; background: var(--panel);
  }
  .op > summary {
    cursor: pointer; padding: 12px 14px; display: flex; gap: 12px;
    align-items: center; list-style: none; flex-wrap: wrap;
  }
  .op > summary::-webkit-details-marker { display: none; }
  .m {
    font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 5px 8px; border-radius: 5px; color: #fff; letter-spacing: .06em;
    min-width: 54px; text-align: center;
  }
  .m.get{background:var(--get)} .m.post{background:var(--post)}
  .m.patch{background:var(--patch)} .m.delete{background:var(--delete)}
  .path { font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .sum { color: var(--muted); font-size: 13px; }
  .lock { font-size: 11px; color: var(--muted); border: 1px solid var(--line);
          padding: 3px 7px; border-radius: 99px; margin-left: auto; }
  .body { padding: 0 14px 16px; border-top: 1px solid var(--line); }
  .body p { white-space: pre-wrap; }
  h4 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
       color: var(--muted); margin: 18px 0 6px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: 11px;
       text-transform: uppercase; letter-spacing: .06em; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
  pre { background: var(--code); padding: 12px; border-radius: 8px;
        overflow-x: auto; font-size: 12.5px; margin: 6px 0 0; }
  .status { font-weight: 600; font-family: ui-monospace, monospace; }
  .s2 { color: var(--get); } .s4 { color: var(--patch); } .s5 { color: var(--delete); }
  a { color: inherit; }
  .err { padding: 20px; border: 1px solid var(--delete); border-radius: 10px; }
</style>
</head>
<body>
<div class="wrap" id="root">Loading…</div>
<script>
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const cls = (code) => "s" + String(code)[0];

function schemaBlock(schema) {
  if (!schema) return "";
  return "<pre>" + esc(JSON.stringify(schema, null, 2)) + "</pre>";
}

function render(doc) {
  const byTag = new Map((doc.tags || []).map((t) => [t.name, { meta: t, ops: [] }]));
  const other = { meta: { name: "Other", description: "" }, ops: [] };

  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const tag = (op.tags || [])[0];
      (byTag.get(tag) || other).ops.push({ path, method, op });
    }
  }
  if (other.ops.length) byTag.set("Other", other);

  let html =
    "<h1>" + esc(doc.info.title) + " <span class='sum'>v" + esc(doc.info.version) + "</span></h1>" +
    "<p class='desc'>" + esc(doc.info.description || "") + "</p>" +
    "<p class='sum'>Machine-readable: <a href='/openapi.json'><code>/openapi.json</code></a></p>";

  for (const [name, group] of byTag) {
    if (!group.ops.length) continue;
    html += "<h2>" + esc(name) + "</h2>";
    if (group.meta.description) html += "<p class='sum'>" + esc(group.meta.description) + "</p>";

    for (const { path, method, op } of group.ops) {
      const secured = Array.isArray(op.security) ? op.security.length > 0 : true;
      html +=
        "<details class='op'><summary>" +
        "<span class='m " + method + "'>" + method.toUpperCase() + "</span>" +
        "<span class='path'>" + esc(path) + "</span>" +
        "<span class='sum'>" + esc(op.summary || "") + "</span>" +
        "<span class='lock'>" + (secured ? "session required" : "public") + "</span>" +
        "</summary><div class='body'>";

      if (op.description) html += "<p>" + esc(op.description) + "</p>";

      if (op.parameters && op.parameters.length) {
        html += "<h4>Parameters</h4><table><tr><th>Name</th><th>In</th><th>Required</th><th>Notes</th></tr>";
        for (const p of op.parameters) {
          html += "<tr><td><code>" + esc(p.name) + "</code></td><td>" + esc(p.in) +
            "</td><td>" + (p.required ? "yes" : "no") + "</td><td class='sum'>" +
            esc(p.description || "") + "</td></tr>";
        }
        html += "</table>";
      }

      if (op.requestBody) {
        const media = op.requestBody.content || {};
        const type = Object.keys(media)[0];
        html += "<h4>Request body <span class='sum'>(" + esc(type) + ")</span></h4>";
        html += schemaBlock(media[type] && media[type].schema);
      }

      html += "<h4>Responses</h4><table><tr><th>Status</th><th>Meaning</th></tr>";
      for (const [code, res] of Object.entries(op.responses || {})) {
        html += "<tr><td><span class='status " + cls(code) + "'>" + esc(code) +
          "</span></td><td class='sum'>" + esc(res.description || "") + "</td></tr>";
      }
      html += "</table>";

      const ok = (op.responses && (op.responses["200"] || op.responses["201"])) || null;
      const okSchema = ok && ok.content && ok.content["application/json"] &&
        ok.content["application/json"].schema;
      if (okSchema) {
        html += "<h4>Success response</h4>" + schemaBlock(okSchema);
      }

      html += "</div></details>";
    }
  }
  return html;
}

fetch("/openapi.json")
  .then((r) => r.json())
  .then((doc) => { document.getElementById("root").innerHTML = render(doc); })
  .catch((e) => {
    document.getElementById("root").innerHTML =
      "<div class='err'>Could not load <code>/openapi.json</code>: " + esc(e.message) + "</div>";
  });
</script>
</body>
</html>`;
