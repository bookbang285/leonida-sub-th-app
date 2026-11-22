// Platform-neutral core of the GitHub proxy (design: docs/superpowers/specs/2026-11-20-token-proxy-design.md).
// One implementation, two thin wrappers:
//   - Vercel Node functions  site/api/*.js        (adapter: site/api/_gh.js, CommonJS require)
//   - Cloudflare Pages Functions site/functions/api/*.js (adapter: site/functions/_lib/pages.js, ESM import;
//     the Pages bundler (esbuild) imports this CommonJS file fine)
// It is CommonJS on purpose so the Vercel runtime can require() it; it only uses Web-standard
// globals (fetch, JSON, Date) and gets env/ip/base/body from the wrapper -- no process, no Buffer.
// Lives under functions/_lib: Pages does not route files/dirs that start with "_".
// The token lives only in the platform env var GH_TOKEN; it is never sent to clients or logged.
"use strict";

const REPO = "bookbang285/leonida-sub-th";
const API = "https://api.github.com";
const LIB_TAG = /^lib-\d{8}\.\d+$/;
// Encrypted library packs only (livesub/libcrypt.py). Plain .zip packs -- including the
// ones still attached to old releases -- are never listed or served, so app versions
// that only understand plain zips get no library updates.
const LIB_ASSET = /^library-[a-z0-9]+-\d{8}\.\d+\.lsxz$/;

// /api/policy: app versions below min_app must update before use (the app fails open when
// the proxy cannot be reached). Env MIN_APP_VERSION overrides; malformed -> default.
const DEFAULT_MIN_APP = "1.6.9";
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

const ISSUE_PREFIXES = ["แปลหลุด", "แจ้งปัญหา"];
const ISSUE_LABELS = new Set(["missed-report", "user-report"]);
const TITLE_MAX = 256;
const BODY_MAX = 65536;
const JSON_LIMIT = BODY_MAX * 4 + 4096;  // request body cap (characters) for POST routes
const COMMENT_FRESH_MS = 30 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function token(env) {
  const t = String((env && env.GH_TOKEN) || "").trim();
  if (!t) throw httpError(503, "server not configured");
  return t;
}

function gh(env, path, opts = {}) {
  const headers = {
    Authorization: `Bearer ${token(env)}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "LeonidaSubTH-proxy",
    ...(opts.headers || {}),
  };
  return fetch(`${API}${path}`, { ...opts, headers });
}

// A handler result: {status, headers, body (string | null)}; the wrappers turn it into a response.
function json(status, obj, extraHeaders = {}) {
  return { status, headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
    body: JSON.stringify(obj) };
}

function fail(e) {
  const status = e && Number.isInteger(e.status) ? e.status : 502;
  return json(status, { message: status === 502 ? "upstream error" : String(e.message || "error") },
    { "Cache-Control": "no-store" });
}

// raw request text -> plain JSON object, else 413 / 400 (shared by both wrappers' readJson)
function parseJsonObject(raw, limit) {
  if (raw.length > limit) throw httpError(413, "too large");
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch (_) { /* fall through */ }
  throw httpError(400, "bad json");
}

// Best-effort per-IP limiter, per function instance (GitHub's own limits back it up).
// On Cloudflare the real limit will be a dashboard Rate Limiting rule on /api/* (docs/cloudflare-pages.md);
// this stays as a second line of defence.
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

function minApp(env) {
  const v = String((env && env.MIN_APP_VERSION) || "").trim();
  return VERSION.test(v) ? v : DEFAULT_MIN_APP;
}

function validateIssue(p) {
  const title = typeof p.title === "string" ? p.title.trim() : "";
  const body = typeof p.body === "string" ? p.body : "";
  const labels = Array.isArray(p.labels) ? p.labels.filter((l) => ISSUE_LABELS.has(l)) : [];
  if (!title || title.length > TITLE_MAX || !ISSUE_PREFIXES.some((x) => title.startsWith(x))) return null;
  if (!body || body.length > BODY_MAX) return null;
  return { title, body, labels: labels.slice(0, 1) };
}

const allowIssue = limiter(6, HOUR);
const allowComment = limiter(20, HOUR);

// Each route gets a request context from the wrapper:
//   method   "GET" | "POST" | ...
//   query(k) -> string ("" when absent)
//   env      {GH_TOKEN, MIN_APP_VERSION}
//   ip       client IP string ("?" when unknown)
//   base     absolute origin used in asset urls, e.g. "https://www.leonidasubth.com"
//   readJson(limit) -> Promise<object>; throws {status: 413|400}
const routes = {
  // GET /api/asset?id=N -> 302 to GitHub's short-lived signed download URL, for encrypted
  // library packs (.lsxz) only. The bytes never pass through the proxy.
  async asset(c) {
    if (c.method !== "GET" && c.method !== "HEAD") return json(405, { message: "GET only" });
    const id = c.query("id");
    if (!/^\d{1,15}$/.test(id)) return json(400, { message: "bad id" });
    try {
      const meta = await gh(c.env, `/repos/${REPO}/releases/assets/${id}`);
      if (meta.status === 404) return json(404, { message: "not found" });
      if (!meta.ok) throw httpError(502, "upstream");
      const a = await meta.json();
      if (!LIB_ASSET.test(String(a.name || ""))) return json(404, { message: "not found" });
      const r = await gh(c.env, `/repos/${REPO}/releases/assets/${id}`, {
        headers: { Accept: "application/octet-stream" },
        redirect: "manual",
      });
      const loc = r.headers.get("location");
      if (r.status < 300 || r.status >= 400 || !loc) throw httpError(502, "upstream");
      return { status: 302, headers: { Location: loc, "Cache-Control": "no-store" }, body: null };
    } catch (e) {
      return fail(e);
    }
  },

  // POST /api/comment?issue=N {body} -> adds a continuation comment to a missed-line
  // report created in the last 30 minutes (long reports are split over comments).
  async comment(c) {
    if (c.method !== "POST") return json(405, { message: "POST only" });
    const n = c.query("issue");
    if (!/^\d{1,9}$/.test(n)) return json(400, { message: "bad issue" });
    try {
      const p = await c.readJson(JSON_LIMIT);
      const body = typeof p.body === "string" ? p.body : "";
      if (!body || body.length > BODY_MAX) return json(422, { message: "invalid comment" });
      if (!allowComment(c.ip)) return json(429, { message: "too many comments" });
      const ir = await gh(c.env, `/repos/${REPO}/issues/${n}`);
      if (ir.status === 404) return json(404, { message: "not found" });
      if (!ir.ok) throw httpError(502, "upstream");
      const issue = await ir.json();
      const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l && l.name));
      const age = Date.now() - Date.parse(issue.created_at || 0);
      if (issue.pull_request || issue.state !== "open" || !labels.includes("missed-report")
          || !(age >= 0 && age < COMMENT_FRESH_MS)) {
        return json(403, { message: "not allowed" });
      }
      const r = await gh(c.env, `/repos/${REPO}/issues/${n}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      if (r.status === 403 || r.status === 429) return json(429, { message: "rate limited" });
      if (!r.ok) throw httpError(502, "upstream");
      return json(201, { ok: true }, { "Cache-Control": "no-store" });
    } catch (e) {
      return fail(e);
    }
  },

  // POST /api/issues {title, body, labels} -> creates a report issue in the private repo.
  // Only the app's two report kinds pass: fixed title prefixes, fixed labels, size caps.
  async issues(c) {
    if (c.method !== "POST") return json(405, { message: "POST only" });
    try {
      const p = validateIssue(await c.readJson(JSON_LIMIT));
      if (!p) return json(422, { message: "invalid report" });
      if (!allowIssue(c.ip)) return json(429, { message: "too many reports" });
      let r = await gh(c.env, `/repos/${REPO}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
      });
      if (r.status === 422 && p.labels.length) {  // label missing in the repo: retry without
        r = await gh(c.env, `/repos/${REPO}/issues`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: p.title, body: p.body }),
        });
      }
      if (r.status === 403 || r.status === 429) return json(429, { message: "rate limited" });
      if (!r.ok) throw httpError(502, "upstream");
      const j = await r.json();
      return json(201, { number: j.number }, { "Cache-Control": "no-store" });
    } catch (e) {
      return fail(e);
    }
  },

  // GET /api/policy -> {"min_app": "X.Y.Z"}. No GitHub call, no token.
  async policy(c) {
    if (c.method !== "GET" && c.method !== "HEAD") return json(405, { message: "GET only" });
    return json(200, { min_app: minApp(c.env) },
      { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600" });
  },

  // GET /api/releases -> the private repo's library releases (lib-* tags) in GitHub's
  // shape, asset urls pointing at <base>/api/asset. CDN-cached for 5 min.
  async releases(c) {
    if (c.method !== "GET" && c.method !== "HEAD") return json(405, { message: "GET only" });
    try {
      const r = await gh(c.env, `/repos/${REPO}/releases?per_page=20`);
      if (!r.ok) throw httpError(502, "upstream");
      const data = await r.json();
      const out = (Array.isArray(data) ? data : [])
        .filter((rel) => rel && !rel.draft && LIB_TAG.test(String(rel.tag_name || "")))
        .map((rel) => ({
          tag_name: rel.tag_name,
          draft: false,
          prerelease: !!rel.prerelease,
          body: String(rel.body || ""),
          assets: (rel.assets || [])
            .filter((a) => a && LIB_ASSET.test(String(a.name || "")))
            .map((a) => ({ name: a.name, size: a.size, url: `${c.base}/api/asset?id=${encodeURIComponent(a.id)}` })),
        }));
      return json(200, out, { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600" });
    } catch (e) {
      return fail(e);
    }
  },
};

function handle(route, ctx) {
  return routes[route](ctx);
}

module.exports = {
  REPO, API, LIB_TAG, LIB_ASSET, DEFAULT_MIN_APP, BODY_MAX, JSON_LIMIT,
  httpError, token, gh, json, fail, parseJsonObject, limiter, minApp, validateIssue, handle,
};
