// Platform-neutral core of the GitHub proxy (design: docs/superpowers/specs/2026-11-20-token-proxy-design.md).
// One implementation, two thin wrappers:
//   - Vercel Node functions  site/api/*.js        (adapter: site/api/_gh.js, CommonJS require)
//   - Cloudflare Pages Functions site/functions/api/*.js (adapter: site/functions/_lib/pages.js, ESM import;
//     the Pages bundler (esbuild) imports this CommonJS file fine)
// It is CommonJS on purpose so the Vercel runtime can require() it; it only uses Web-standard
// globals (fetch, JSON, Date, TextEncoder, crypto.subtle) and gets env/ip/base/body from the wrapper --
// no process, no Buffer. Report bodies are checked by ./reports.js (same file on both platforms).
// Lives under functions/_lib: Pages does not route files/dirs that start with "_".
// The token lives only in the platform env var GH_TOKEN; it is never sent to clients or logged.
"use strict";

const reports = require("./reports.js");

const REPO = "bookbang285/leonida-sub-th";
const API = "https://api.github.com";
const LIB_TAG = /^lib-\d{8}\.\d+$/;
// Encrypted library packs only: .lsxz (livesub/libcrypt.py, v1/v2) and .lsp3 (v3, opened
// with the key from /api/libkey). Plain .zip packs -- including the ones still attached to
// old releases -- are never listed or served, so app versions that only understand plain
// zips get no library updates.
const LIB_ASSET = /^library-[a-z0-9]+-\d{8}\.\d+\.(lsxz|lsp3)$/;

// /api/policy: app versions below min_app must update before use (the app fails open when
// the proxy cannot be reached). Env MIN_APP_VERSION overrides; malformed -> default.
const DEFAULT_MIN_APP = "1.6.9";
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

const BODY_MAX = reports.ISSUE_MAX;
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

// Only bodies exactly as livesub/reporter.py builds them pass (./reports.js) -> {title, body, labels}
// with the label of the report kind, or null.
function validateIssue(p) {
  const r = reports.validateReport(p);
  return r && { title: r.title, body: r.body, labels: r.labels, kind: r.kind };
}

// Report token: /api/issues returns HMAC-SHA256(key, "issue:<n>") for a missed-line report and
// /api/comment checks it, so only the creator can continue a report. Key = env REPORT_SECRET,
// else derived from GH_TOKEN (neither ever leaves the server). Apps <= 1.6.13 send no token:
// a missing token is accepted (fresh issue + strict template) unless env REPORT_TOKEN_REQUIRED=1.
const TOKEN_RE = /^[0-9a-f]{64}$/;
const subtle = () => (globalThis.crypto && globalThis.crypto.subtle) || null;
const utf8 = (s) => new TextEncoder().encode(s);
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

async function reportKey(env) {
  const s = subtle();
  if (!s) return null;
  const secret = String((env && env.REPORT_SECRET) || "").trim();
  let raw;
  if (secret) raw = utf8(secret);
  else {
    const gk = await s.importKey("raw", utf8(token(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    raw = await s.sign("HMAC", gk, utf8("leonida-sub-th report-token v1"));
  }
  return s.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function reportToken(env, issue) {
  const key = await reportKey(env);
  return key ? hex(await subtle().sign("HMAC", key, utf8(`issue:${issue}`))) : null;
}

// true / false; null = cannot check here (no Web Crypto)
async function checkReportToken(env, issue, tok) {
  if (typeof tok !== "string" || !TOKEN_RE.test(tok)) return false;
  const key = await reportKey(env);
  if (!key) return null;
  const sig = new Uint8Array(tok.match(/../g).map((h) => parseInt(h, 16)));
  return subtle().verify("HMAC", key, sig, utf8(`issue:${issue}`));  // constant time
}

const tokenRequired = (env) => /^(1|true|yes)$/i.test(String((env && env.REPORT_TOKEN_REQUIRED) || "").trim());

// ---- anonymous usage count (docs/usage-stats.md) ----
// The app may add ?i=<install id>&v=<app>&l=<library>&os=win|mac to /api/policy (only while the
// user leaves "ส่งสถิติการใช้งานแบบไม่ระบุตัวตน" on). Strictly validated, then one row per Thai
// calendar day per id in the Cloudflare D1 binding USAGE_DB (INSERT OR IGNORE): no IP, no
// headers, nothing else. Without the binding (Vercel) nothing is recorded.
const USAGE_ID = /^[0-9a-f]{32}$/;
const USAGE_LIB = /^\d{8}\.\d{1,4}$/;
const USAGE_OS = ["win", "mac"];
const DAY_MS = 24 * HOUR;
const TH_OFFSET_MS = 7 * HOUR;  // days are Thai dates (UTC+7)
const allowUsage = limiter(240, HOUR);  // per IP, in memory only (never stored)

function usageDb(env) {
  const db = env && env.USAGE_DB;
  return db && typeof db.prepare === "function" ? db : null;
}

function usageDay(now = Date.now()) {
  return new Date(now + TH_OFFSET_MS).toISOString().slice(0, 10);
}

// query -> {id, v, l, os} when every value is well-formed, else null (nothing recorded)
function usageRecord(query) {
  const id = query("i");
  if (!id) return null;
  const v = query("v"), l = query("l"), os = query("os");
  if (!USAGE_ID.test(id) || !VERSION.test(v) || !(l === "" || USAGE_LIB.test(l)) || !USAGE_OS.includes(os)) {
    return null;
  }
  return { id, v, l, os };
}

const INSERT_SEEN = "INSERT OR IGNORE INTO seen (day, id, v, l, os) VALUES (?1, ?2, ?3, ?4, ?5)";

// true when written; never throws (a broken database never breaks /api/policy)
async function recordUsage(env, rec, now = Date.now()) {
  const db = usageDb(env);
  if (!db || !rec) return false;
  try {
    await db.prepare(INSERT_SEEN).bind(usageDay(now), rec.id, rec.v, rec.l, rec.os).run();
    return true;
  } catch (_) {
    return false;
  }
}

async function sameSecret(a, b) {
  const s = subtle();
  if (!s) return a.length === b.length && a === b;
  const [x, y] = await Promise.all([s.digest("SHA-256", utf8(a)), s.digest("SHA-256", utf8(b))]);
  return hex(x) === hex(y);
}

async function rows(db, sql, ...args) {
  const r = await db.prepare(sql).bind(...args).all();
  return (r && Array.isArray(r.results)) ? r.results : [];
}

// aggregates for /api/usage: DAU for the last 30 days (split by os), 7/30-day uniques, by os
// and app version
async function usageStats(db, now = Date.now()) {
  const since = (n) => usageDay(now - (n - 1) * DAY_MS);
  const [dauRows, u7, u30, os7, os30, v7, v30] = await Promise.all([
    rows(db, "SELECT day, os, COUNT(*) AS n FROM seen WHERE day >= ?1 GROUP BY day, os ORDER BY day", since(30)),
    rows(db, "SELECT COUNT(DISTINCT id) AS n FROM seen WHERE day >= ?1", since(7)),
    rows(db, "SELECT COUNT(DISTINCT id) AS n FROM seen WHERE day >= ?1", since(30)),
    rows(db, "SELECT os, COUNT(DISTINCT id) AS n FROM seen WHERE day >= ?1 GROUP BY os", since(7)),
    rows(db, "SELECT os, COUNT(DISTINCT id) AS n FROM seen WHERE day >= ?1 GROUP BY os", since(30)),
    rows(db, "SELECT v, COUNT(DISTINCT id) AS n FROM seen WHERE day >= ?1 GROUP BY v ORDER BY n DESC, v DESC", since(7)),
    rows(db, "SELECT v, COUNT(DISTINCT id) AS n FROM seen WHERE day >= ?1 GROUP BY v ORDER BY n DESC, v DESC", since(30)),
  ]);
  const num = (x) => Number(x) || 0;
  const days = [];
  for (let i = 29; i >= 0; i--) days.push({ day: usageDay(now - i * DAY_MS), total: 0, win: 0, mac: 0 });
  const byDay = new Map(days.map((d) => [d.day, d]));
  for (const r of dauRows) {
    const d = byDay.get(String(r.day));
    if (!d) continue;
    d.total += num(r.n);
    if (USAGE_OS.includes(r.os)) d[r.os] += num(r.n);
  }
  const byOs = (list) => {
    const o = { win: 0, mac: 0 };
    for (const r of list) if (USAGE_OS.includes(r.os)) o[r.os] = num(r.n);
    return o;
  };
  const byV = (list) => list.map((r) => ({ v: String(r.v), n: num(r.n) }));
  return {
    today: usageDay(now),
    dau: days,
    unique_7d: num(u7[0] && u7[0].n),
    unique_30d: num(u30[0] && u30[0].n),
    os_7d: byOs(os7),
    os_30d: byOs(os30),
    version_7d: byV(v7),
    version_30d: byV(v30),
  };
}

// ---- /api/libkey: the v3 library key, wrapped to one device (Cloudflare only) ----
// Contract: docs/superpowers/plans/2026-11-23-library-protection-170.md "v3 format contract"
// (Python reference tools/lsth3/crypto.py; byte-exact, pinned by tests/proxy/libkey.test.mjs).
//   LK  = hkdf(MASTER, "lsth3", "lib <game> <library_version>", 32)
//   eph = fresh X25519 key pair; wk = hkdf(X25519(eph_sk, dev_pub), eph_pub||dev_pub, "lsth3 wrap"||PEPPER, 32)
//   box = seal(wk, 16*00, "lsth3 libkey <game> <library_version>", LK)
// MASTER is the Cloudflare secret LIBKEY_MASTER (hex); it never leaves the server. PEPPER is the
// Cloudflare secret LIBKEY_PEPPER (64 hex, the app's build secret wrap_pepper, constant forever):
// without it a self-made keypair could not unwrap what this endpoint sends. Never on Vercel:
// there is no site/api/libkey.js, so /api/libkey there stays 404.
const LIBKEY_MIN_APP = "1.7.0";
const LIBKEY_GAME = /^[a-z0-9]{1,32}$/;
const LIBKEY_LIB = /^\d{8}\.\d{1,4}$/;
const LIBKEY_PUB = /^[A-Za-z0-9+/]{43}=$/;  // standard base64 of exactly 32 bytes
const LIBKEY_MASTER_RE = /^[0-9a-fA-F]{64}$/;  // exactly 32 bytes; anything else = 503 (never a silently different key)
const LIBKEY_PEPPER_RE = /^[0-9a-fA-F]{64}$/;  // LIBKEY_PEPPER: exactly 32 bytes, else 503
const LIBKEY_PER_DAY = 20;  // per device id (D1, when bound)
const allowLibkey = limiter(10, HOUR);  // per IP, in memory only (never stored)
const INSERT_LIBKEY = "INSERT INTO libkey (day, did, game, lib, app, country) VALUES (?1, ?2, ?3, ?4, ?5, ?6)";
const COUNT_LIBKEY = "SELECT COUNT(*) AS n FROM libkey WHERE day = ?1 AND did = ?2";
const X25519_PKCS8 = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20];

const unhexBytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const concatBytes = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const b64encode = (u8) => btoa(String.fromCharCode(...u8));
const b64decode = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));

function versionAtLeast(v, min) {
  if (typeof v !== "string" || !VERSION.test(v)) return false;
  const a = v.split(".").map(Number), b = min.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

async function hmacSha256(key, data) {
  const k = await subtle().importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", k, data));
}

async function hkdf(ikm, salt, info, n) {
  const k = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, n * 8));
}

// seal(key, nonce16, aad, pt) -> ct||tag16 (v3 contract)
async function seal(key, nonce, aad, pt) {
  const ek = await hmacSha256(key, utf8("enc")), mk = await hmacSha256(key, utf8("mac"));
  const ct = new Uint8Array(pt.length);
  for (let ctr = 0; ctr * 32 < pt.length; ctr++) {
    const c = new Uint8Array(8);
    new DataView(c.buffer).setBigUint64(0, BigInt(ctr));
    const ks = await hmacSha256(ek, concatBytes(nonce, c));
    for (let i = 0; i < 32 && ctr * 32 + i < pt.length; i++) ct[ctr * 32 + i] = pt[ctr * 32 + i] ^ ks[i];
  }
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, aad.length);
  const tag = (await hmacSha256(mk, concatBytes(len, aad, nonce, ct))).slice(0, 16);
  return concatBytes(ct, tag);
}

// -> {g, l, eph, box} (libkey.bin). ephSk (32 bytes) only for test vectors; normally a fresh key.
// Throws {status: 400} for a low-order device key (all-zero shared secret), 503 for a bad pepper.
async function libkeyWrap(masterHex, pepperHex, game, version, pubBytes, ephSk) {
  const s = subtle();
  if (!s) throw httpError(503, "no web crypto");
  if (!LIBKEY_PEPPER_RE.test(String(pepperHex || ""))) throw httpError(503, "server not configured");
  if (!(pubBytes instanceof Uint8Array) || pubBytes.length !== 32) throw httpError(400, "bad pub");
  const lk = await hkdf(unhexBytes(masterHex), utf8("lsth3"), utf8(`lib ${game} ${version}`), 32);
  let ephPriv, ephPub;
  if (ephSk) {
    ephPriv = await s.importKey("pkcs8", concatBytes(Uint8Array.from(X25519_PKCS8), ephSk), { name: "X25519" },
      true, ["deriveBits"]);
    ephPub = b64decode((await s.exportKey("jwk", ephPriv)).x);
  } else {
    const kp = await s.generateKey({ name: "X25519" }, true, ["deriveBits"]);
    ephPriv = kp.privateKey;
    ephPub = new Uint8Array(await s.exportKey("raw", kp.publicKey));
  }
  let shared;
  try {
    const dev = await s.importKey("raw", pubBytes, { name: "X25519" }, false, []);
    shared = new Uint8Array(await s.deriveBits({ name: "X25519", public: dev }, ephPriv, 256));
  } catch (_) {
    throw httpError(400, "bad pub");  // runtimes that refuse low-order points themselves
  }
  if (shared.every((b) => b === 0)) throw httpError(400, "bad pub");
  const wk = await hkdf(shared, concatBytes(ephPub, pubBytes), concatBytes(utf8("lsth3 wrap"), unhexBytes(pepperHex)), 32);
  const box = await seal(wk, new Uint8Array(16), utf8(`lsth3 libkey ${game} ${version}`), lk);
  return { g: game, l: version, eph: b64encode(ephPub), box: b64encode(box) };
}

// per-device count for today; null = unknown (database error: never blocks)
async function libkeyCountToday(db, day, did) {
  try {
    const r = await rows(db, COUNT_LIBKEY, day, did);
    return Number(r[0] && r[0].n) || 0;
  } catch (_) {
    return null;
  }
}

// true when written; never throws
async function recordLibkey(db, args) {
  try {
    await db.prepare(INSERT_LIBKEY).bind(...args).run();
    return true;
  } catch (_) {
    return false;
  }
}

const allowIssue = limiter(6, HOUR);
const allowComment = limiter(20, HOUR);

// Each route gets a request context from the wrapper:
//   method   "GET" | "POST" | ...
//   query(k) -> string ("" when absent)
//   env      {GH_TOKEN, MIN_APP_VERSION, USAGE_KEY, USAGE_DB (Cloudflare D1 binding), ...}
//   ip       client IP string ("?" when unknown)
//   base     absolute origin used in asset urls, e.g. "https://www.leonidasubth.com"
//   readJson(limit) -> Promise<object>; throws {status: 413|400}
//   waitUntil(promise)  optional (Pages): finish work after the response
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

  // POST /api/comment?issue=N {body, token?} -> adds a continuation comment to a missed-line
  // report created in the last 30 minutes (long reports are split over comments). The body must
  // be one of the app's continuation templates and fit what the issue still expects; a token
  // (from /api/issues) must match when sent, and is required when REPORT_TOKEN_REQUIRED=1.
  async comment(c) {
    if (c.method !== "POST") return json(405, { message: "POST only" });
    const n = c.query("issue");
    if (!/^\d{1,9}$/.test(n)) return json(400, { message: "bad issue" });
    try {
      const p = await c.readJson(JSON_LIMIT);
      const body = typeof p.body === "string" ? p.body : "";
      if (!body || body.length > BODY_MAX || Object.keys(p).some((k) => k !== "body" && k !== "token")
          || (p.token !== undefined && typeof p.token !== "string")) {
        return json(422, { message: "invalid comment" });
      }
      if (p.token !== undefined) {
        const ok = await checkReportToken(c.env, n, p.token);
        if (ok === false) return json(403, { message: "not allowed" });
      } else if (tokenRequired(c.env)) {
        return json(403, { message: "not allowed" });
      }
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
      if (!reports.validateComment(body, issue)) return json(422, { message: "invalid comment" });
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

  // POST /api/libkey {v, g, l, pub, i?} -> 200 libkey.bin {g, l, eph, box} for apps >= 1.7.0.
  // 426 old/malformed app version, 503 no/malformed LIBKEY_MASTER or LIBKEY_PEPPER, 400 bad g/l/pub/i, 429 over 10/hour per
  // IP (memory) or 20/day per device id did = hex(sha256(pub))[:32] (D1 USAGE_DB, when bound).
  // One D1 row per answer (day, did, game, lib, app, country) -- no IP, no install id.
  async libkey(c) {
    const NS = { "Cache-Control": "no-store" };
    if (c.method !== "POST") return json(405, { message: "POST only" }, NS);
    try {
      const p = await c.readJson(4096);
      if (!versionAtLeast(p.v, LIBKEY_MIN_APP)) return json(426, { message: "update the app" }, NS);
      const master = String((c.env && c.env.LIBKEY_MASTER) || "").trim();
      if (!LIBKEY_MASTER_RE.test(master)) return json(503, { message: "server not configured" }, NS);
      const pepper = String((c.env && c.env.LIBKEY_PEPPER) || "").trim();
      if (!LIBKEY_PEPPER_RE.test(pepper)) return json(503, { message: "server not configured" }, NS);
      const { g, l, pub, i } = p;
      if (typeof g !== "string" || !LIBKEY_GAME.test(g)) return json(400, { message: "bad game" }, NS);
      if (typeof l !== "string" || !LIBKEY_LIB.test(l)) return json(400, { message: "bad library version" }, NS);
      if (typeof pub !== "string" || !LIBKEY_PUB.test(pub)) return json(400, { message: "bad pub" }, NS);
      // install id: validated only, intentionally never stored or used (the D1 row keys on did)
      if (i !== undefined && (typeof i !== "string" || !USAGE_ID.test(i))) return json(400, { message: "bad id" }, NS);
      const pubBytes = b64decode(pub);
      // top bit set = non-canonical X25519 encoding (same point as with it cleared): refuse so did is stable
      if (pubBytes.length !== 32 || (pubBytes[31] & 0x80)) return json(400, { message: "bad pub" }, NS);
      if (!allowLibkey(c.ip)) return json(429, { message: "too many requests" }, NS);
      const did = hex(await subtle().digest("SHA-256", pubBytes)).slice(0, 32);
      const day = usageDay();
      const db = usageDb(c.env);
      if (db) {
        const n = await libkeyCountToday(db, day, did);
        if (n !== null && n >= LIBKEY_PER_DAY) return json(429, { message: "too many requests" }, NS);
      }
      const out = await libkeyWrap(master, pepper, g, l, pubBytes);
      if (db) {
        const country = /^[A-Z]{2}$/.test(String(c.country || "")) ? c.country : "";
        const w = recordLibkey(db, [day, did, g, l, p.v, country]);
        if (typeof c.waitUntil === "function") c.waitUntil(w);
        else await w;
      }
      return json(200, out, NS);
    } catch (e) {
      return fail(e);
    }
  },

  // POST /api/issues {title, body, labels} -> creates a report issue in the private repo.
  // Only the app's two report kinds pass, exactly as the app builds them (./reports.js).
  // A missed-line report answers {number, token}: the token lets its creator add the
  // continuation comments (/api/comment).
  async issues(c) {
    if (c.method !== "POST") return json(405, { message: "POST only" });
    try {
      const p = validateIssue(await c.readJson(JSON_LIMIT));
      if (!p) return json(422, { message: "invalid report" });
      if (!allowIssue(c.ip)) return json(429, { message: "too many reports" });
      let r = await gh(c.env, `/repos/${REPO}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: p.title, body: p.body, labels: p.labels }),
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
      const out = { number: j.number };
      if (p.kind === "missed" && Number.isInteger(j.number)) {
        const t = await reportToken(c.env, j.number);
        if (t) out.token = t;
      }
      return json(201, out, { "Cache-Control": "no-store" });
    } catch (e) {
      return fail(e);
    }
  },

  // GET /api/policy -> {"min_app": "X.Y.Z"}. No GitHub call, no token. With the optional
  // anonymous usage params (?i&v&l&os) a valid set is counted once per day in USAGE_DB (when
  // bound); invalid params or no binding are ignored silently -- the answer is the same.
  async policy(c) {
    if (c.method !== "GET" && c.method !== "HEAD") return json(405, { message: "GET only" });
    const counted = c.query("i") !== "";
    if (counted) {
      const rec = usageRecord(c.query);
      if (rec && usageDb(c.env) && allowUsage(c.ip)) {
        const p = recordUsage(c.env, rec);
        if (typeof c.waitUntil === "function") c.waitUntil(p);  // Pages: answer first
        else await p;
      }
    }
    return json(200, { min_app: minApp(c.env) },
      { "Cache-Control": counted ? "no-store" : "public, s-maxage=60, stale-while-revalidate=600" });
  },

  // GET /api/usage?key=<USAGE_KEY> -> usage aggregates (usageStats). Anything else -- no
  // USAGE_KEY set, wrong/missing key, other methods -- is a plain 404.
  async usage(c) {
    const nf = () => json(404, { message: "not found" }, { "Cache-Control": "no-store" });
    const secret = String((c.env && c.env.USAGE_KEY) || "").trim();
    if (c.method !== "GET" || !secret || !(await sameSecret(c.query("key"), secret))) return nf();
    const db = usageDb(c.env);
    if (!db) return json(503, { message: "no usage database" }, { "Cache-Control": "no-store" });
    try {
      return json(200, await usageStats(db), { "Cache-Control": "no-store" });
    } catch (_) {
      return json(502, { message: "usage database error" }, { "Cache-Control": "no-store" });
    }
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
  reportToken, checkReportToken, validateComment: reports.validateComment,
  usageDay, usageRecord, recordUsage, usageStats, INSERT_SEEN,
  LIBKEY_MIN_APP, INSERT_LIBKEY, libkeyWrap,
};
