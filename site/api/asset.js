// GET /api/asset?id=N -> 302 to GitHub's short-lived signed download URL, for library
// zips only. The bytes never pass through Vercel.
"use strict";
const { REPO, LIB_ASSET, gh, send, fail } = require("./_gh");

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { message: "GET only" });
  const id = String((req.query && req.query.id) || "");
  if (!/^\d{1,15}$/.test(id)) return send(res, 400, { message: "bad id" });
  try {
    const meta = await gh(`/repos/${REPO}/releases/assets/${id}`);
    if (meta.status === 404) return send(res, 404, { message: "not found" });
    if (!meta.ok) throw Object.assign(new Error("upstream"), { status: 502 });
    const a = await meta.json();
    if (!LIB_ASSET.test(String(a.name || ""))) return send(res, 404, { message: "not found" });
    const r = await gh(`/repos/${REPO}/releases/assets/${id}`, {
      headers: { Accept: "application/octet-stream" },
      redirect: "manual",
    });
    const loc = r.headers.get("location");
    if (r.status < 300 || r.status >= 400 || !loc) throw Object.assign(new Error("upstream"), { status: 502 });
    res.statusCode = 302;
    res.setHeader("Location", loc);
    res.setHeader("Cache-Control", "no-store");
    res.end();
  } catch (e) {
    fail(res, e);
  }
};
