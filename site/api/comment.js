// POST /api/comment?issue=N {body} -> adds a continuation comment to a missed-line
// report created in the last 30 minutes (long reports are split over comments).
// Logic: ../functions/_lib/gh.js
"use strict";
module.exports = require("./_gh").vercelHandler("comment");
