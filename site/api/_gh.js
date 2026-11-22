// Vercel adapter for the GitHub proxy (design: docs/superpowers/specs/2026-11-20-token-proxy-design.md).
// The logic lives in ../functions/_lib/gh.js (shared with the Cloudflare Pages Functions in
// ../functions/api/); this file only maps Node req/res <-> the core's {status, headers, body}.
// The token lives only in the env var GH_TOKEN; it is never sent to clients or logged.
"use strict";
const core = require("../functions/_lib/gh.js");

const { REPO, LIB_TAG, LIB_ASSET, limiter } = core;
// Asset urls in /api/releases. Never derived from client headers (x-forwarded-host is
// spoofable); PUBLIC_BASE_URL overrides for previews/other domains.
const DEFAULT_BASE_URL = "https://leonida-sub-th-app.vercel.app";

function gh(path, opts) {
  return core.gh(process.env, path, opts);
}

function send(res, status, obj, extraHeaders = {}) {
  write(res, core.json(status, obj, extraHeaders));
}

function fail(res, e) {
  write(res, core.fail(e));
}

function write(res, out) {
  res.statusCode = out.status;
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  if (out.body === null || out.body === undefined) res.end();
  else res.end(out.body);
}

async function readJson(req, limit) {
  // Vercel pre-parses application/json bodies into req.body
  if (req.body !== undefined && req.body !== null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    if (JSON.stringify(req.body).length > limit) throw core.httpError(413, "too large");
    return req.body;
  }
  let raw = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString("utf8") : null;
  if (raw === null) {
    raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > limit) throw core.httpError(413, "too large");
    }
  }
  return core.parseJsonObject(raw, limit);
}

function clientIp(req) {
  const xf = String((req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "");
  return xf.split(",")[0].trim() || "?";
}

function baseUrl() {
  const env = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return env || DEFAULT_BASE_URL;
}

// route name (key of core routes) -> Vercel handler(req, res)
function vercelHandler(route) {
  return async function handler(req, res) {
    const out = await core.handle(route, {
      method: req.method,
      query: (k) => String((req.query && req.query[k]) || ""),
      env: process.env,
      get ip() { return clientIp(req); },
      get base() { return baseUrl(); },
      readJson: (limit) => readJson(req, limit),
    });
    write(res, out);
  };
}

module.exports = { REPO, LIB_TAG, LIB_ASSET, DEFAULT_BASE_URL, gh, send, fail, readJson, limiter, clientIp,
  baseUrl, vercelHandler };
