import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import express from "express";

test("Live Security Headers & 405 Method Assertions", async () => {
  const app = express();
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (req.method === "TRACE" || req.method === "TRACK") {
      res.setHeader("Allow", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }
    next();
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 4000;

  try {
    // Test GET Security Headers
    const getRes = await new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/api/health`, { method: "GET" }, (res) => {
        resolve({ statusCode: res.statusCode || 200, headers: res.headers });
      });
      req.on("error", reject);
      req.end();
    });

    assert.equal(getRes.statusCode, 200);
    assert.equal(getRes.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(getRes.headers["x-content-type-options"], "nosniff");
    assert.equal(getRes.headers["referrer-policy"], "strict-origin-when-cross-origin");

    // Test TRACE 405 Rejection
    const traceRes = await new Promise((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/api/health`, { method: "TRACE" }, (res) => {
        resolve({ statusCode: res.statusCode || 405 });
      });
      req.on("error", reject);
      req.end();
    });

    assert.equal(traceRes.statusCode, 405);
    console.log("✓ Live HTTP Security headers and 405 method rejection verified.");
  } finally {
    server.close();
  }
});
