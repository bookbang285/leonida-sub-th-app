// GET /api/releases -> the private repo's library releases (lib-* tags) in GitHub's
// shape, asset urls pointing at <PUBLIC_BASE_URL or the vercel.app domain>/api/asset.
// CDN-cached for 5 min. Logic: ../functions/_lib/gh.js
"use strict";
module.exports = require("./_gh").vercelHandler("releases");
