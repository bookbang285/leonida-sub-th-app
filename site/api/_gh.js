// Shared helpers for the GitHub proxy (design: docs/superpowers/specs/2026-11-20-token-proxy-design.md).
// The token lives only in the Vercel env var GH_TOKEN; it is never sent to clients or logged.
"use strict";

const REPO = "bookbang285/leonida-sub-th";
const API = "https://api.github.com";
const LIB_TAG = /^lib-\d{8}\.\d+$/;
const LIB_ASSET = /^library-[a-z0-9]+-\d{8}\.\d+\.zip$/;

function token() {
  const t = (process.env.GH_TOKEN || "").trim();
  if (!t) throw Object.assign(new Error("server not configured"), { status: 503 });
  return t;
}

function gh(path, opts = {}) {
  const headers = {
    Authorization: `Bearer ${token()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "LeonidaSubTH-proxy",
    ...(opts.headers || {}),
  };
  return fetch(`${API}${path}`, { ...opts, headers });
}

function send(res, status, obj, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(JSON.stringify(obj));
}

function fail(res, e) {
  const status = e && Number.isInteger(e.status) ? e.status : 502;
  send(res, status, { message: status === 502 ? "upstream error" : String(e.message || "error") },
    { "Cache-Control": "no-store" });
}

async function readJson(req, limit) {
  if (req.body !== undefined && req.body !== null && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
    if (JSON.stringify(req.body).length > limit) throw Object.assign(new Error("too large"), { status: 413 });
    return req.body;
  }
  let raw = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString("utf8") : null;
  if (raw === null) {
    raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > limit) throw Object.assign(new Error("too large"), { status: 413 });
    }
  }
  if (raw.length > limit) throw Object.assign(new Error("too large"), { status: 413 });
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch (_) { /* fall through */ }
  throw Object.assign(new Error("bad json"), { status: 400 });
}

// best-effort per-IP limiter (per function instance; GitHub's own limits back it up)
function limiter(max, windowMs) {
  const hits = new Map();
  return function allow(ip, now = Date.now()) {
    const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) { hits.set(ip, list); return false; }
    list.push(now);
    hits.set(ip, list);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}

function clientIp(req) {
  const xf = String((req.headers && (req.headers["x-forwarded-for"] || req.headers["x-real-ip"])) || "");
  return xf.split(",")[0].trim() || "?";
}

function baseUrl(req) {
  const host = String((req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "");
  return `https://${host}`;
}

module.exports = { REPO, LIB_TAG, LIB_ASSET, gh, send, fail, readJson, limiter, clientIp, baseUrl };
