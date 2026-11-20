// POST /api/issues {title, body, labels} -> creates a report issue in the private repo.
// Only the app's two report kinds pass: fixed title prefixes, fixed labels, size caps.
"use strict";
const { REPO, gh, send, fail, readJson, limiter, clientIp } = require("./_gh");

const PREFIXES = ["แปลหลุด", "แจ้งปัญหา"];
const LABELS = new Set(["missed-report", "user-report"]);
const TITLE_MAX = 256;
const BODY_MAX = 65536;
const allow = limiter(6, 60 * 60 * 1000);

function validate(p) {
  const title = typeof p.title === "string" ? p.title.trim() : "";
  const body = typeof p.body === "string" ? p.body : "";
  const labels = Array.isArray(p.labels) ? p.labels.filter((l) => LABELS.has(l)) : [];
  if (!title || title.length > TITLE_MAX || !PREFIXES.some((x) => title.startsWith(x))) return null;
  if (!body || body.length > BODY_MAX) return null;
  return { title, body, labels: labels.slice(0, 1) };
}

async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { message: "POST only" });
  try {
    const p = validate(await readJson(req, BODY_MAX * 4 + 4096));
    if (!p) return send(res, 422, { message: "invalid report" });
    if (!allow(clientIp(req))) return send(res, 429, { message: "too many reports" });
    let r = await gh(`/repos/${REPO}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    });
    if (r.status === 422 && p.labels.length) {  // label missing in the repo: retry without
      r = await gh(`/repos/${REPO}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: p.title, body: p.body }),
      });
    }
    if (r.status === 403 || r.status === 429) return send(res, 429, { message: "rate limited" });
    if (!r.ok) throw Object.assign(new Error("upstream"), { status: 502 });
    const j = await r.json();
    send(res, 201, { number: j.number }, { "Cache-Control": "no-store" });
  } catch (e) {
    fail(res, e);
  }
}

module.exports = handler;
module.exports.validate = validate;
