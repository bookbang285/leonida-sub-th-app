// GET /api/usage?key=<USAGE_KEY> -> anonymous usage aggregates (docs/usage-stats.md); 404 without
// the key. Vercel has no D1 binding, so with the key it answers 503 (the count lives on Cloudflare).
// Logic: ../functions/_lib/gh.js
"use strict";
module.exports = require("./_gh").vercelHandler("usage");
