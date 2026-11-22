// GET /api/asset?id=N -> 302 to GitHub's short-lived signed download URL, for encrypted library
// packs (.lsxz) only. The bytes never pass through Vercel. Logic: ../functions/_lib/gh.js
"use strict";
module.exports = require("./_gh").vercelHandler("asset");
