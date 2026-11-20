// GET /api/releases -> the private repo's library releases (lib-* tags) in GitHub's
// shape, asset urls pointing at /api/asset. CDN-cached for 5 min.
"use strict";
const { REPO, LIB_TAG, LIB_ASSET, gh, send, fail, baseUrl } = require("./_gh");

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { message: "GET only" });
  try {
    const r = await gh(`/repos/${REPO}/releases?per_page=20`);
    if (!r.ok) throw Object.assign(new Error("upstream"), { status: 502 });
    const data = await r.json();
    const base = baseUrl(req);
    const out = (Array.isArray(data) ? data : [])
      .filter((rel) => rel && !rel.draft && LIB_TAG.test(String(rel.tag_name || "")))
      .map((rel) => ({
        tag_name: rel.tag_name,
        draft: false,
        prerelease: !!rel.prerelease,
        body: String(rel.body || ""),
        assets: (rel.assets || [])
          .filter((a) => a && LIB_ASSET.test(String(a.name || "")))
          .map((a) => ({ name: a.name, size: a.size, url: `${base}/api/asset?id=${encodeURIComponent(a.id)}` })),
      }));
    send(res, 200, out, { "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600" });
  } catch (e) {
    fail(res, e);
  }
};
