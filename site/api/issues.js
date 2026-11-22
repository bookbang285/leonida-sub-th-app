// POST /api/issues {title, body, labels} -> creates a report issue in the private repo.
// Only the app's two report kinds pass: fixed title prefixes, fixed labels, size caps.
// Logic: ../functions/_lib/gh.js
"use strict";
const core = require("../functions/_lib/gh.js");

module.exports = require("./_gh").vercelHandler("issues");
module.exports.validate = core.validateIssue;
