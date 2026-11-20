// POST /api/comment?issue=N {body} -> adds a continuation comment to a missed-line
// report created in the last 30 minutes (long reports are split over comments).
"use strict";
const { REPO, gh, send, fail, readJson, limiter, clientIp } = require("./_gh");

const BODY_MAX = 65536;
const FRESH_MS = 30 * 60 * 1000;
const allow = limiter(20, 60 * 60 * 1000);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { message: "POST only" });
  const n = String((req.query && req.query.issue) || "");
  if (!/^\d{1,9}$/.test(n)) return send(res, 400, { message: "bad issue" });
  try {
    const p = await readJson(req, BODY_MAX * 4 + 4096);
    const body = typeof p.body === "string" ? p.body : "";
    if (!body || body.length > BODY_MAX) return send(res, 422, { message: "invalid comment" });
    if (!allow(clientIp(req))) return send(res, 429, { message: "too many comments" });
    const ir = await gh(`/repos/${REPO}/issues/${n}`);
    if (ir.status === 404) return send(res, 404, { message: "not found" });
    if (!ir.ok) throw Object.assign(new Error("upstream"), { status: 502 });
    const issue = await ir.json();
    const labels = (issue.labels || []).map((l) => (typeof l === "string" ? l : l && l.name));
    const age = Date.now() - Date.parse(issue.created_at || 0);
    if (issue.pull_request || issue.state !== "open" || !labels.includes("missed-report") || !(age >= 0 && age < FRESH_MS)) {
      return send(res, 403, { message: "not allowed" });
    }
    const r = await gh(`/repos/${REPO}/issues/${n}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (r.status === 403 || r.status === 429) return send(res, 429, { message: "rate limited" });
    if (!r.ok) throw Object.assign(new Error("upstream"), { status: 502 });
    send(res, 201, { ok: true }, { "Cache-Control": "no-store" });
  } catch (e) {
    fail(res, e);
  }
};
